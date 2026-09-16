import { Chapter, ReaderPositionState, ApiConfig } from '../types';
import { sanitizeTextForAiPrompt } from './readerAiEngine';

// ─── 类型定义 ───

export interface TextChunk {
  id: string;
  bookId: string;
  chapterIndex: number;
  startOffset: number;
  endOffset: number;
  text: string;
}

interface StoredEmbedding {
  chunkId: string;
  bookId: string;
  chapterIndex: number;
  startOffset: number;
  endOffset: number;
  text: string;
  embedding: number[] | Float32Array;
}

interface RagBookMeta {
  bookId: string;
  chunkCount: number;
  indexedUpTo: number;
  updatedAt: number;
  contentSignature?: string;
  ragModelPresetId?: string;
  embeddingModelSignature?: string;
}

interface RetrieveRelevantChunksOptions {
  topK?: number;
  perBookTopK?: number;
}

export interface RagModelDebugEvent {
  time: number;
  type:
    | 'model-load-start'
    | 'host-check-start'
    | 'host-check-success'
    | 'host-check-failed'
    | 'pipeline-load-start'
    | 'pipeline-load-success'
    | 'pipeline-load-failed'
    | 'cache-clear-start'
    | 'cache-clear-success'
    | 'cache-clear-failed'
    | 'host-attempt-failed'
    | 'model-load-success'
    | 'model-load-failed';
  host?: string;
  url?: string;
  detail?: string;
}

export interface RagModelDebugSnapshot {
  modelLoaded: boolean;
  hosts: string[];
  events: RagModelDebugEvent[];
}

export interface RagStorageUsageResult {
  totalBytes: number;
  embeddingsBytes: number;
  metaBytes: number;
}

export interface RagArchiveEmbedding {
  chunkId: string;
  bookId: string;
  chapterIndex: number;
  startOffset: number;
  endOffset: number;
  text: string;
  embedding: number[];
}

export interface RagArchiveMeta {
  bookId: string;
  chunkCount: number;
  indexedUpTo: number;
  updatedAt: number;
  contentSignature?: string;
  ragModelPresetId?: string;
  embeddingModelSignature?: string;
}

export interface RagArchivePayload {
  embeddings: RagArchiveEmbedding[];
  meta: RagArchiveMeta[];
}

export class RagEmbeddingApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'RagEmbeddingApiError';
    this.status = status;
  }
}

type RagModelDebugListener = (event: RagModelDebugEvent) => void;

// ─── 常量 ───

const CHUNK_SIZE = 512;
const CHUNK_OVERLAP = 64;
const CHUNK_STEP = CHUNK_SIZE - CHUNK_OVERLAP;
const MIN_CHUNK_TEXT_LENGTH = 20;
const CHUNKING_STRATEGY_SIGNATURE = 'sentence-boundary-v1';
const CHUNK_SENTENCE_BOUNDARY_BACKWARD_SCAN = 180;
const CHUNK_SENTENCE_BOUNDARY_FORWARD_SCAN = 120;
const CHUNK_MIN_LENGTH_GUARD = Math.max(MIN_CHUNK_TEXT_LENGTH, Math.floor(CHUNK_SIZE * 0.35));
const TOP_K = 5;
const DEFAULT_PER_BOOK_TOP_K = 2;
const KEYWORD_BOOST_WEIGHT = 0.08;
const API_EMBEDDING_BATCH_SIZE = 32;
const API_EMBEDDING_TIMEOUT_MS = 45_000;
const API_EMBEDDING_MAX_ATTEMPTS = 3;
const MODEL_NAME = 'Xenova/multilingual-e5-small';
const HF_REMOTE_HOST = 'https://huggingface.co/';
const HF_REMOTE_PATH_TEMPLATE = '{model}/resolve/{revision}/';
const HF_REMOTE_REVISION = 'main';
const RAG_MODEL_MIRRORS = ['https://hf-mirror.com/'];
const MODEL_HEALTHCHECK_FILES = ['config.json', 'tokenizer_config.json'];
const TRANSFORMERS_CACHE_NAME = 'transformers-cache';
const RAG_DEBUG_EVENT_LIMIT = 100;
const MODEL_HOST_CHECK_TIMEOUT_MS = 15000;
const MODEL_PIPELINE_LOAD_TIMEOUT_MS = 120000;
const MODEL_PIPELINE_LOAD_TIMEOUT_IOS_MS = 240000;
const MODEL_STALL_TIMEOUT_MS = 30000;
const MODEL_STALL_TIMEOUT_IOS_MS = 60000;

const RAG_DB_NAME = 'app_rag_embeddings_v1';
const RAG_DB_VERSION = 1;
const EMBEDDINGS_STORE = 'embeddings';
const META_STORE = 'meta';

const createEmbeddingModelSignature = (presetId?: string, apiConfig?: ApiConfig): string => {
  if (!apiConfig) return `local:${MODEL_NAME}`;
  return [
    'api',
    presetId || '',
    apiConfig.provider || '',
    (apiConfig.endpoint || '').trim().replace(/\/+$/, ''),
    (apiConfig.model || '').trim(),
  ].join(':');
};

const ragModelDebugListeners = new Set<RagModelDebugListener>();
const ragModelDebugEvents: RagModelDebugEvent[] = [];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const isBrowserCacheAvailable = (): boolean => {
  try {
    if (typeof globalThis === 'undefined') return false;
    const cacheApi = (globalThis as { caches?: { open?: unknown } }).caches;
    if (!cacheApi) return false;
    return typeof cacheApi.open === 'function';
  } catch {
    return false;
  }
};

const isLikelyIOSRuntime = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const touchPoints = navigator.maxTouchPoints || 0;
  return /iPad|iPhone|iPod/i.test(ua) || (platform === 'MacIntel' && touchPoints > 1);
};

const promiseWithTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> => {
  if (typeof AbortController === 'undefined') {
    return promiseWithTimeout(
      fetch(url, init),
      timeoutMs,
      `[RAG] Fetch timeout (${timeoutMs}ms): ${url}`,
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`[RAG] Fetch timeout (${timeoutMs}ms): ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
};

const formatRagDebugDetail = (value: unknown): string => {
  const raw = value instanceof Error
    ? `${value.message}${value.stack ? `\n${value.stack}` : ''}`
    : String(value ?? '');
  return raw.replace(/\s+/g, ' ').trim().slice(0, 500);
};

const emitRagModelDebugEvent = (
  event: Omit<RagModelDebugEvent, 'time'> & { time?: number },
): void => {
  const normalized: RagModelDebugEvent = {
    ...event,
    time: typeof event.time === 'number' ? event.time : Date.now(),
    detail: typeof event.detail === 'string' ? event.detail.slice(0, 500) : event.detail,
  };
  ragModelDebugEvents.push(normalized);
  if (ragModelDebugEvents.length > RAG_DEBUG_EVENT_LIMIT) {
    ragModelDebugEvents.splice(0, ragModelDebugEvents.length - RAG_DEBUG_EVENT_LIMIT);
  }
  ragModelDebugListeners.forEach((listener) => {
    try {
      listener(normalized);
    } catch {
      // ignore subscriber errors
    }
  });
};

export const subscribeRagModelDebugEvents = (
  listener: RagModelDebugListener,
): (() => void) => {
  ragModelDebugListeners.add(listener);
  return () => {
    ragModelDebugListeners.delete(listener);
  };
};

export const getRagModelDebugSnapshot = (): RagModelDebugSnapshot => ({
  modelLoaded,
  hosts: getRagModelHosts(),
  events: [...ragModelDebugEvents],
});

const inFlightIndexByBook = new Map<string, Promise<void>>();
const pendingIndexByBook = new Map<string, {
  chapters: Chapter[];
  targetOffset: number;
  onProgress?: (pct: number) => void;
  ragModelPresetId?: string;
  ragApiConfig?: ApiConfig;
}>();

interface PreparedChapter {
  chapterIndex: number;
  rawLength: number;
  text: string;
  startOffset: number;
  endOffset: number;
}

interface PreparedChapterMetrics {
  chapters: PreparedChapter[];
  rawTotalLength: number;
  sanitizedTotalLength: number;
}

const preparedChapterMetricsCache = new WeakMap<Chapter[], PreparedChapterMetrics>();

// ─── IndexedDB ───

let ragDbPromise: Promise<IDBDatabase> | null = null;

const openRagDb = (): Promise<IDBDatabase> => {
  if (ragDbPromise) return ragDbPromise;
  ragDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(RAG_DB_NAME, RAG_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(EMBEDDINGS_STORE)) {
        const store = db.createObjectStore(EMBEDDINGS_STORE, { keyPath: 'chunkId' });
        store.createIndex('byBook', 'bookId', { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'bookId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      ragDbPromise = null;
      reject(request.error);
    };
  });
  return ragDbPromise;
};

const storeEmbeddings = async (embeddings: StoredEmbedding[]): Promise<void> => {
  const db = await openRagDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EMBEDDINGS_STORE, 'readwrite');
    const store = tx.objectStore(EMBEDDINGS_STORE);
    for (const emb of embeddings) {
      store.put(emb);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

const getEmbeddingsByBook = async (bookId: string): Promise<StoredEmbedding[]> => {
  const db = await openRagDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EMBEDDINGS_STORE, 'readonly');
    const store = tx.objectStore(EMBEDDINGS_STORE);
    const index = store.index('byBook');
    const request = index.getAll(bookId);
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
};

export const deleteEmbeddingsByBook = async (bookId: string): Promise<void> => {
  const db = await openRagDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([EMBEDDINGS_STORE, META_STORE], 'readwrite');
    const store = tx.objectStore(EMBEDDINGS_STORE);
    const index = store.index('byBook');
    const request = index.openCursor(bookId);
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    // 同时删除 meta
    tx.objectStore(META_STORE).delete(bookId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

const saveBookMeta = async (meta: RagBookMeta): Promise<void> => {
  const db = await openRagDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put(meta);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const getBookMeta = async (bookId: string): Promise<RagBookMeta | null> => {
  const db = await openRagDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readonly');
    const request = tx.objectStore(META_STORE).get(bookId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
};

const getAllFromStore = async <T>(storeName: string): Promise<T[]> => {
  const db = await openRagDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.getAll();
    request.onsuccess = () => resolve((request.result || []) as T[]);
    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
};

const normalizeArchiveEmbedding = (value: unknown): StoredEmbedding | null => {
  if (!isRecord(value)) return null;
  const chunkId = typeof value.chunkId === 'string' ? value.chunkId.trim() : '';
  const bookId = typeof value.bookId === 'string' ? value.bookId.trim() : '';
  const text = typeof value.text === 'string' ? value.text : '';
  const chapterIndex = Number(value.chapterIndex);
  const startOffset = Number(value.startOffset);
  const endOffset = Number(value.endOffset);
  if (!chunkId || !bookId || !text) return null;
  if (!Number.isFinite(chapterIndex) || chapterIndex < 0) return null;
  if (!Number.isFinite(startOffset) || startOffset < 0) return null;
  if (!Number.isFinite(endOffset) || endOffset < startOffset) return null;
  const rawEmbedding = Array.isArray(value.embedding) || value.embedding instanceof Float32Array
    ? value.embedding
    : null;
  if (!rawEmbedding) return null;

  const embedding = Float32Array.from(rawEmbedding, (item) => Number(item));
  if (embedding.length === 0 || embedding.some((item) => !Number.isFinite(item))) return null;

  return {
    chunkId,
    bookId,
    chapterIndex: Math.floor(chapterIndex),
    startOffset: Math.floor(startOffset),
    endOffset: Math.floor(endOffset),
    text,
    embedding,
  };
};

const normalizeArchiveMeta = (value: unknown): RagBookMeta | null => {
  if (!isRecord(value)) return null;
  const bookId = typeof value.bookId === 'string' ? value.bookId.trim() : '';
  const chunkCount = Number(value.chunkCount);
  const indexedUpTo = Number(value.indexedUpTo);
  const updatedAt = Number(value.updatedAt);
  if (!bookId) return null;
  if (!Number.isFinite(chunkCount) || chunkCount < 0) return null;
  if (!Number.isFinite(indexedUpTo) || indexedUpTo < 0) return null;
  if (!Number.isFinite(updatedAt) || updatedAt < 0) return null;

  return {
    bookId,
    chunkCount: Math.floor(chunkCount),
    indexedUpTo: Math.floor(indexedUpTo),
    updatedAt: Math.floor(updatedAt),
    contentSignature: typeof value.contentSignature === 'string' && value.contentSignature.trim()
      ? value.contentSignature
      : undefined,
    ragModelPresetId: typeof value.ragModelPresetId === 'string' && value.ragModelPresetId.trim()
      ? value.ragModelPresetId
      : undefined,
    embeddingModelSignature: typeof value.embeddingModelSignature === 'string' && value.embeddingModelSignature.trim()
      ? value.embeddingModelSignature
      : undefined,
  };
};

const replaceAllRagRecords = async (
  embeddings: StoredEmbedding[],
  metaEntries: RagBookMeta[],
): Promise<void> => {
  const db = await openRagDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([EMBEDDINGS_STORE, META_STORE], 'readwrite');
    const embeddingStore = tx.objectStore(EMBEDDINGS_STORE);
    const metaStore = tx.objectStore(META_STORE);
    embeddingStore.clear();
    metaStore.clear();

    embeddings.forEach((entry) => {
      embeddingStore.put(entry);
    });
    metaEntries.forEach((entry) => {
      metaStore.put(entry);
    });

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
};

export const exportRagIndexForArchive = async (): Promise<RagArchivePayload> => {
  const [rawEmbeddings, rawMeta] = await Promise.all([
    getAllFromStore<StoredEmbedding>(EMBEDDINGS_STORE),
    getAllFromStore<RagBookMeta>(META_STORE),
  ]);

  const embeddings = rawEmbeddings
    .map((entry) => normalizeArchiveEmbedding(entry))
    .filter((entry): entry is StoredEmbedding => Boolean(entry))
    .map((entry) => ({
      chunkId: entry.chunkId,
      bookId: entry.bookId,
      chapterIndex: entry.chapterIndex,
      startOffset: entry.startOffset,
      endOffset: entry.endOffset,
      text: entry.text,
      embedding: Array.from(entry.embedding),
    }));

  const meta = rawMeta
    .map((entry) => normalizeArchiveMeta(entry))
    .filter((entry): entry is RagBookMeta => Boolean(entry))
    .map((entry) => ({
      bookId: entry.bookId,
      chunkCount: entry.chunkCount,
      indexedUpTo: entry.indexedUpTo,
      updatedAt: entry.updatedAt,
      ...(entry.contentSignature ? { contentSignature: entry.contentSignature } : {}),
      ...(entry.ragModelPresetId ? { ragModelPresetId: entry.ragModelPresetId } : {}),
      ...(entry.embeddingModelSignature ? { embeddingModelSignature: entry.embeddingModelSignature } : {}),
    }));

  return { embeddings, meta };
};

export const restoreRagIndexFromArchive = async (raw: unknown): Promise<void> => {
  const source = isRecord(raw) ? raw : {};
  const embeddingsSource = Array.isArray(source.embeddings) ? source.embeddings : [];
  const metaSource = Array.isArray(source.meta) ? source.meta : [];

  const embeddings = embeddingsSource
    .map((entry) => normalizeArchiveEmbedding(entry))
    .filter((entry): entry is StoredEmbedding => Boolean(entry));
  const metaEntries = metaSource
    .map((entry) => normalizeArchiveMeta(entry))
    .filter((entry): entry is RagBookMeta => Boolean(entry));

  pendingIndexByBook.clear();
  await replaceAllRagRecords(embeddings, metaEntries);
};

const getStoreUsageBytes = async (storeName: string): Promise<number> => {
  const db = await openRagDb();
  const encoder = new TextEncoder();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.openCursor();
    let total = 0;

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(total);
        return;
      }
      try {
        const value = cursor.value;
        const embedding = isRecord(value) ? value.embedding : null;
        if (embedding instanceof Float32Array) {
          const { embedding: _embedding, ...metadata } = value;
          total += encoder.encode(JSON.stringify(metadata)).length + embedding.byteLength;
        } else {
          total += encoder.encode(JSON.stringify(value)).length;
        }
      } catch {
        // Skip malformed records and keep scanning.
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
};

export const getRagStorageUsageBytes = async (): Promise<RagStorageUsageResult> => {
  try {
    const [embeddingsBytes, metaBytes] = await Promise.all([
      getStoreUsageBytes(EMBEDDINGS_STORE),
      getStoreUsageBytes(META_STORE),
    ]);
    return {
      totalBytes: Math.max(0, embeddingsBytes + metaBytes),
      embeddingsBytes: Math.max(0, embeddingsBytes),
      metaBytes: Math.max(0, metaBytes),
    };
  } catch {
    return {
      totalBytes: 0,
      embeddingsBytes: 0,
      metaBytes: 0,
    };
  }
};

const clampOffset = (value: number, fallback: number = 0): number => {
  if (!Number.isFinite(value)) return Math.max(0, Math.floor(fallback));
  return Math.max(0, Math.floor(value));
};

const clampOffsetWithin = (value: number, max: number, fallback: number = 0): number =>
  Math.min(Math.max(0, Math.floor(max)), clampOffset(value, fallback));

const yieldToMainThread = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

const getPreparedChapterMetrics = (chapters: Chapter[]): PreparedChapterMetrics => {
  const cached = preparedChapterMetricsCache.get(chapters);
  if (cached) return cached;

  const preparedChapters: PreparedChapter[] = [];
  let rawCursor = 0;
  let sanitizedCursor = 0;

  for (let i = 0; i < chapters.length; i++) {
    const rawText = chapters[i]?.content || '';
    const sanitizedText = sanitizeTextForAiPrompt(rawText);
    const rawLength = rawText.length;
    const sanitizedLength = sanitizedText.length;

    preparedChapters.push({
      chapterIndex: i,
      rawLength,
      text: sanitizedText,
      startOffset: sanitizedCursor,
      endOffset: sanitizedCursor + sanitizedLength,
    });

    rawCursor += rawLength;
    sanitizedCursor += sanitizedLength;
  }

  const metrics: PreparedChapterMetrics = {
    chapters: preparedChapters,
    rawTotalLength: rawCursor,
    sanitizedTotalLength: sanitizedCursor,
  };
  preparedChapterMetricsCache.set(chapters, metrics);
  return metrics;
};

export const estimateRagSafeOffset = (
  chapters: Chapter[] | null | undefined,
  readingPosition: ReaderPositionState | null | undefined,
  fallbackOffset: number = 0,
): number => {
  const safeFallback = clampOffset(fallbackOffset, 0);
  if (!Array.isArray(chapters) || chapters.length === 0) return safeFallback;

  const metrics = getPreparedChapterMetrics(chapters);
  const totalSanitized = Math.max(0, metrics.sanitizedTotalLength);
  if (totalSanitized <= 0) return 0;

  if (!readingPosition) {
    return clampOffsetWithin(safeFallback, totalSanitized, safeFallback);
  }

  const chapterIndex = readingPosition.chapterIndex;
  if (
    typeof chapterIndex === 'number' &&
    Number.isFinite(chapterIndex) &&
    chapterIndex >= 0 &&
    chapterIndex < metrics.chapters.length
  ) {
    const chapter = metrics.chapters[chapterIndex];
    const safeRawInChapter = clampOffset(readingPosition.chapterCharOffset, 0);
    const chapterRawLength = Math.max(0, chapter.rawLength);
    const ratio = chapterRawLength > 0 ? Math.min(1, safeRawInChapter / chapterRawLength) : 0;
    const projectedInChapter = Math.round(ratio * chapter.text.length);
    return clampOffsetWithin(chapter.startOffset + projectedInChapter, totalSanitized, safeFallback);
  }

  const safeRawGlobal = clampOffset(readingPosition.globalCharOffset, 0);
  if (metrics.rawTotalLength > 0) {
    const ratio = Math.min(1, safeRawGlobal / metrics.rawTotalLength);
    return clampOffsetWithin(Math.round(ratio * totalSanitized), totalSanitized, safeFallback);
  }

  return clampOffsetWithin(safeFallback, totalSanitized, safeFallback);
};

const createChaptersSignature = (chapters: Chapter[]): string => {
  // FNV-1a 32-bit hash，快速识别书籍内容是否变化（用于决定是否重建索引）
  let hash = 0x811c9dc5;
  const feed = (input: string) => {
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
  };

  const metrics = getPreparedChapterMetrics(chapters);
  feed(CHUNKING_STRATEGY_SIGNATURE);
  feed(String(metrics.chapters.length));
  for (let i = 0; i < metrics.chapters.length; i++) {
    const title = chapters[i]?.title || '';
    const text = metrics.chapters[i].text;
    const previewHead = text.slice(0, 80);
    const previewTail = text.slice(-80);
    feed(`${i}|${title}|${text.length}|${previewHead}|${previewTail}`);
  }
  return (hash >>> 0).toString(16);
};

const extractQueryTerms = (query: string): string[] => {
  const normalized = sanitizeTextForAiPrompt(query || '').toLowerCase();
  if (!normalized) return [];

  const matchedTerms = normalized.match(/[\p{Script=Han}]{2,}|[a-z0-9]{2,}/giu) || [];
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const rawTerm of matchedTerms) {
    const term = rawTerm.trim();
    if (!term || term.length < 2 || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= 12) break;
  }
  return terms;
};

const computeKeywordBoost = (text: string, queryTerms: string[]): number => {
  if (queryTerms.length === 0 || !text) return 0;
  const haystack = text.toLowerCase();
  let boost = 0;
  for (const term of queryTerms) {
    if (!haystack.includes(term)) continue;
    const lenWeight = term.length >= 6 ? 1.2 : term.length >= 4 ? 1.0 : 0.7;
    boost += lenWeight;
  }
  return boost;
};

// ─── 文本分块 ───

const SENTENCE_BOUNDARY_PUNCTUATION = new Set([
  '.',
  '!',
  '?',
  ';',
  '。',
  '！',
  '？',
  '；',
  '｡',
  '．',
  '﹒',
  '…',
  '⋯',
  '︙',
]);

const SENTENCE_BOUNDARY_TRAILING_CHARS = new Set([
  '"',
  '\'',
  ')',
  ']',
  '}',
  '）',
  '】',
  '」',
  '』',
  '》',
  '〉',
  '”',
  '’',
]);

const isDigitChar = (char: string | undefined): boolean => Boolean(char && char >= '0' && char <= '9');

const isSentenceBoundaryAt = (text: string, index: number): boolean => {
  if (index < 0 || index >= text.length) return false;
  const char = text[index];
  if (char === '\n') return true;
  if (!SENTENCE_BOUNDARY_PUNCTUATION.has(char)) return false;

  // Keep decimal numbers (e.g. 3.14) from being treated as sentence boundaries.
  if ((char === '.' || char === '．' || char === '﹒') && isDigitChar(text[index - 1]) && isDigitChar(text[index + 1])) {
    return false;
  }
  return true;
};

const expandSentenceBoundaryEnd = (text: string, boundaryIndex: number, maxEndExclusive: number): number => {
  let end = Math.min(maxEndExclusive, boundaryIndex + 1);
  while (end < maxEndExclusive) {
    const char = text[end];
    if (SENTENCE_BOUNDARY_TRAILING_CHARS.has(char)) {
      end += 1;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\r') {
      end += 1;
      continue;
    }
    if (char === '\n') {
      end += 1;
      while (end < maxEndExclusive && text[end] === '\n') end += 1;
      break;
    }
    if (SENTENCE_BOUNDARY_PUNCTUATION.has(char)) {
      end += 1;
      continue;
    }
    break;
  }
  return end;
};

const pickChunkEndBySentenceBoundary = (
  text: string,
  chunkStart: number,
  hardEndExclusive: number,
  chapterUpperExclusive: number,
): number => {
  const hardEnd = clampOffsetWithin(hardEndExclusive, chapterUpperExclusive, hardEndExclusive);
  const minProtectedEnd = Math.min(chapterUpperExclusive, chunkStart + CHUNK_MIN_LENGTH_GUARD);
  if (hardEnd <= minProtectedEnd) return hardEnd;

  const forwardScanStart = Math.max(chunkStart, hardEnd - 1);
  const forwardScanEnd = Math.min(chapterUpperExclusive, hardEnd + CHUNK_SENTENCE_BOUNDARY_FORWARD_SCAN);
  for (let index = forwardScanStart; index < forwardScanEnd; index += 1) {
    if (!isSentenceBoundaryAt(text, index)) continue;
    const candidateEnd = Math.min(
      chapterUpperExclusive,
      expandSentenceBoundaryEnd(text, index, chapterUpperExclusive)
    );
    if (candidateEnd <= minProtectedEnd) continue;
    return candidateEnd;
  }

  const backwardScanStart = Math.min(chapterUpperExclusive - 1, hardEnd - 1);
  const backwardScanEnd = Math.max(minProtectedEnd - 1, hardEnd - CHUNK_SENTENCE_BOUNDARY_BACKWARD_SCAN);
  for (let index = backwardScanStart; index >= backwardScanEnd; index -= 1) {
    if (!isSentenceBoundaryAt(text, index)) continue;
    const candidateEnd = Math.min(
      chapterUpperExclusive,
      expandSentenceBoundaryEnd(text, index, chapterUpperExclusive)
    );
    if (candidateEnd <= minProtectedEnd) continue;
    return candidateEnd;
  }

  return hardEnd;
};

interface LocalChunkRange {
  start: number;
  end: number;
}

const buildChapterChunkRanges = (
  chapterText: string,
  chapterStartOffset: number,
  lowerBoundExclusive: number,
  upperBoundExclusive: number,
): LocalChunkRange[] => {
  const chapterLen = chapterText.length;
  if (chapterLen <= 0) return [];

  const chapterEndOffset = chapterStartOffset + chapterLen;
  const localUpperExclusive = clampOffsetWithin(upperBoundExclusive - chapterStartOffset, chapterLen, chapterLen);
  if (localUpperExclusive <= 0) return [];

  const clampedLowerBound = clampOffsetWithin(lowerBoundExclusive, chapterEndOffset, 0);
  const localLowerExclusive = clampOffsetWithin(clampedLowerBound - chapterStartOffset, localUpperExclusive, 0);
  const ranges: LocalChunkRange[] = [];
  let chunkStart = 0;

  while (chunkStart < localUpperExclusive) {
    const remaining = localUpperExclusive - chunkStart;
    if (remaining <= MIN_CHUNK_TEXT_LENGTH) {
      const tailEnd = localUpperExclusive;
      if (tailEnd > localLowerExclusive) {
        ranges.push({ start: chunkStart, end: tailEnd });
      }
      break;
    }

    const hardEnd = Math.min(chunkStart + CHUNK_SIZE, localUpperExclusive);
    let chunkEnd = pickChunkEndBySentenceBoundary(chapterText, chunkStart, hardEnd, localUpperExclusive);
    chunkEnd = Math.min(localUpperExclusive, chunkEnd);
    if (chunkEnd - chunkStart < MIN_CHUNK_TEXT_LENGTH) {
      chunkEnd = Math.min(localUpperExclusive, chunkStart + CHUNK_SIZE);
    }
    if (chunkEnd - chunkStart < MIN_CHUNK_TEXT_LENGTH) {
      chunkEnd = localUpperExclusive;
    }
    if (chunkEnd <= chunkStart) break;

    if (chunkEnd > localLowerExclusive) {
      ranges.push({ start: chunkStart, end: chunkEnd });
    }
    if (chunkEnd >= localUpperExclusive) break;

    let nextStart = Math.max(0, chunkEnd - CHUNK_OVERLAP);
    if (nextStart <= chunkStart) {
      nextStart = Math.min(localUpperExclusive, chunkStart + Math.max(1, CHUNK_STEP));
    }
    if (nextStart <= chunkStart) break;
    chunkStart = nextStart;
  }

  return ranges;
};

export const chunkBookText = (
  bookId: string,
  chapters: Chapter[],
  maxGlobalOffset: number,
): TextChunk[] => {
  const chunks: TextChunk[] = [];
  let globalOffset = 0;

  for (let ci = 0; ci < chapters.length; ci++) {
    const rawContent = chapters[ci].content || '';
    const chapterText = sanitizeTextForAiPrompt(rawContent);
    const chapterLen = chapterText.length;
    const ranges = buildChapterChunkRanges(chapterText, globalOffset, 0, maxGlobalOffset);
    for (const range of ranges) {
      const text = chapterText.slice(range.start, range.end);
      if (text.length < MIN_CHUNK_TEXT_LENGTH) continue;
      chunks.push({
        id: `${bookId}_ch${ci}_${range.start}`,
        bookId,
        chapterIndex: ci,
        startOffset: globalOffset + range.start,
        endOffset: globalOffset + range.end,
        text,
      });
    }
    globalOffset += chapterLen;
    if (globalOffset >= maxGlobalOffset) break;
  }
  return chunks;
};

const chunkBookTextInRange = (
  bookId: string,
  chapters: Chapter[],
  startOffsetExclusive: number,
  maxGlobalOffset: number,
): TextChunk[] => {
  const upperBound = clampOffset(maxGlobalOffset, 0);
  const lowerBound = clampOffset(startOffsetExclusive, 0);
  if (upperBound <= lowerBound) return [];

  const chunks: TextChunk[] = [];
  let globalOffset = 0;

  for (let ci = 0; ci < chapters.length; ci++) {
    const rawContent = chapters[ci].content || '';
    const chapterText = sanitizeTextForAiPrompt(rawContent);
    const chapterLen = chapterText.length;
    const ranges = buildChapterChunkRanges(chapterText, globalOffset, lowerBound, upperBound);
    for (const range of ranges) {
      const start = globalOffset + range.start;
      const end = globalOffset + range.end;
      if (end <= lowerBound || start >= upperBound) continue;
      const text = chapterText.slice(range.start, range.end);
      if (text.length < MIN_CHUNK_TEXT_LENGTH) continue;
      chunks.push({
        id: `${bookId}_ch${ci}_${range.start}`,
        bookId,
        chapterIndex: ci,
        startOffset: start,
        endOffset: end,
        text,
      });
    }

    globalOffset += chapterLen;
    if (globalOffset >= upperBound) break;
  }

  return chunks;
};

// ─── Embedding 模型（懒加载单例，从 Hugging Face 远程加载） ───

let embedPipelinePromise: Promise<any> | null = null;
let modelLoaded = false;
let modelLoadProgress = 0;
const modelLoadProgressListeners = new Set<(progress: number) => void>();

const emitModelLoadProgress = (progress: number): void => {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  modelLoadProgress = clamped;
  modelLoadProgressListeners.forEach((listener) => {
    try {
      listener(clamped);
    } catch {
      // ignore listener errors
    }
  });
};

const subscribeModelLoadProgress = (listener: (progress: number) => void): (() => void) => {
  modelLoadProgressListeners.add(listener);
  try {
    listener(modelLoadProgress);
  } catch {
    // ignore listener errors
  }
  return () => {
    modelLoadProgressListeners.delete(listener);
  };
};

const getNumericProgressField = (source: Record<string, unknown>, key: string): number | null => {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const parseModelLoadProgressEvent = (event: unknown): number | null => {
  if (!isRecord(event)) return null;
  const loaded = getNumericProgressField(event, 'loaded');
  const total = getNumericProgressField(event, 'total');
  if (loaded !== null && total !== null && total > 0) {
    return Math.max(0, Math.min(1, loaded / total));
  }
  const progress = getNumericProgressField(event, 'progress');
  if (progress !== null) {
    const normalized = progress > 1 ? progress / 100 : progress;
    return Math.max(0, Math.min(1, normalized));
  }
  return null;
};

export const isEmbedModelLoaded = () => modelLoaded;
export const warmupRagModel = async (onProgress?: (progress: number) => void): Promise<void> => {
  const unsubscribe = onProgress ? subscribeModelLoadProgress(onProgress) : null;
  try {
    if (modelLoaded) emitModelLoadProgress(1);
    await getEmbedPipeline();
    emitModelLoadProgress(1);
  } finally {
    unsubscribe?.();
  }
};

const normalizeHost = (host: string): string => host.endsWith('/') ? host : `${host}/`;

const getRagModelHosts = (): string[] => {
  const envMirrorRaw = (import.meta as any)?.env?.VITE_RAG_MIRRORS as string | undefined;
  const envMirrors = typeof envMirrorRaw === 'string'
    ? envMirrorRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  const allHosts = [HF_REMOTE_HOST, ...envMirrors, ...RAG_MODEL_MIRRORS].map(normalizeHost);
  return Array.from(new Set(allHosts));
};

const isHtmlLikePayload = (contentType: string, payloadStart: string): boolean => {
  const ct = contentType.toLowerCase();
  const prefix = payloadStart.trimStart().slice(0, 32).toLowerCase();
  return ct.includes('text/html') || prefix.startsWith('<!doctype html') || prefix.startsWith('<html');
};

const ensureModelHostHealth = async (host: string): Promise<void> => {
  const base = `${normalizeHost(host)}${MODEL_NAME}/resolve/${encodeURIComponent(HF_REMOTE_REVISION)}/`;

  for (const file of MODEL_HEALTHCHECK_FILES) {
    const url = `${base}${file}`;
    emitRagModelDebugEvent({ type: 'host-check-start', host, url, detail: file });
    const resp = await fetchWithTimeout(url, { cache: 'no-store' }, MODEL_HOST_CHECK_TIMEOUT_MS);
    if (!resp.ok) {
      const message = `[RAG] Host check failed (${resp.status}): ${url}`;
      emitRagModelDebugEvent({ type: 'host-check-failed', host, url, detail: message });
      throw new Error(message);
    }

    const contentType = resp.headers.get('content-type') || '';
    const payload = await resp.text();
    if (isHtmlLikePayload(contentType, payload)) {
      const message = `[RAG] Host check returned HTML instead of JSON: ${url}`;
      emitRagModelDebugEvent({ type: 'host-check-failed', host, url, detail: message });
      throw new Error(message);
    }

    try {
      JSON.parse(payload);
    } catch {
      const message = `[RAG] Host check got invalid JSON: ${url}`;
      emitRagModelDebugEvent({ type: 'host-check-failed', host, url, detail: message });
      throw new Error(message);
    }
    emitRagModelDebugEvent({ type: 'host-check-success', host, url, detail: file });
  }
};

const shouldResetTransformersCache = (err: unknown): boolean => {
  const msg = err instanceof Error ? `${err.message}\n${err.stack || ''}` : String(err);
  return msg.includes("Unexpected token '<'") || msg.includes('<!DOCTYPE');
};

const clearTransformersCache = async (): Promise<void> => {
  if (!isBrowserCacheAvailable()) {
    emitRagModelDebugEvent({ type: 'cache-clear-failed', detail: 'Cache API is unavailable in current runtime' });
    return;
  }
  emitRagModelDebugEvent({ type: 'cache-clear-start', detail: TRANSFORMERS_CACHE_NAME });
  try {
    await caches.delete(TRANSFORMERS_CACHE_NAME);
    emitRagModelDebugEvent({ type: 'cache-clear-success', detail: TRANSFORMERS_CACHE_NAME });
  } catch {
    emitRagModelDebugEvent({ type: 'cache-clear-failed', detail: 'Failed to delete transformers-cache' });
    // ignore cache clear failures
  }
};

const getEmbedPipeline = async () => {
  if (!embedPipelinePromise) {
    embedPipelinePromise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers');
      const isIOSRuntime = isLikelyIOSRuntime();
      // Vite 预打包会 shim fs 模块，导致库误判为 Node 环境
      // 强制关闭文件系统访问，使用浏览器 fetch 加载
      env.useFS = false;
      env.useFSCache = false;
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
      env.remotePathTemplate = HF_REMOTE_PATH_TEMPLATE;
      // 使用浏览器 Cache API 缓存以加速后续加载
      const browserCacheAvailable = isBrowserCacheAvailable() && !isIOSRuntime;
      env.useBrowserCache = browserCacheAvailable;
      const pipelineLoadTimeoutMs = isIOSRuntime
        ? MODEL_PIPELINE_LOAD_TIMEOUT_IOS_MS
        : MODEL_PIPELINE_LOAD_TIMEOUT_MS;
      const onnxWasm = (env as any)?.backends?.onnx?.wasm;
      if (isIOSRuntime && onnxWasm && typeof onnxWasm === 'object') {
        if ('numThreads' in onnxWasm) onnxWasm.numThreads = 1;
        if ('proxy' in onnxWasm) onnxWasm.proxy = false;
      }

      const hosts = getRagModelHosts();
      const stallTimeoutMs = isIOSRuntime ? MODEL_STALL_TIMEOUT_IOS_MS : MODEL_STALL_TIMEOUT_MS;
      emitModelLoadProgress(0);
      emitRagModelDebugEvent({
        type: 'model-load-start',
        detail: `hosts=${hosts.join(', ')} | browserCache=${browserCacheAvailable ? 'on' : 'off'} | ios=${isIOSRuntime ? 'yes' : 'no'} | timeout=${pipelineLoadTimeoutMs}ms | stall=${stallTimeoutMs}ms`,
      });

      // ── 并行健康预检：所有 host 同时检查，全不可达时 ~15s 快速失败 ──
      const healthResults = await Promise.allSettled(
        hosts.map(async (host) => {
          await ensureModelHostHealth(host);
          return host;
        }),
      );
      const healthyHosts = healthResults
        .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
        .map((r) => r.value);

      if (healthyHosts.length === 0) {
        const lastReason = healthResults.length > 0 && healthResults[healthResults.length - 1].status === 'rejected'
          ? formatRagDebugDetail((healthResults[healthResults.length - 1] as PromiseRejectedResult).reason)
          : 'all checks failed';
        emitRagModelDebugEvent({
          type: 'model-load-failed',
          detail: `All hosts unreachable (fast-fail) | hosts=${hosts.join(', ')} | last=${lastReason}`,
        });
        emitModelLoadProgress(0);
        throw new Error(`[RAG] All model hosts are unreachable (${hosts.join(', ')}). ${lastReason}`);
      }

      let lastError: unknown = null;

      for (const host of healthyHosts) {
        try {
          env.remoteHost = normalizeHost(host);

          // ── 停滞检测：追踪 progress_callback 最后触发时间 ──
          let lastRealProgressAt = Date.now();

          const loadPipe = () => pipeline('feature-extraction', MODEL_NAME, {
            revision: HF_REMOTE_REVISION,
            progress_callback: (event: unknown) => {
              const progress = parseModelLoadProgressEvent(event);
              if (progress !== null) {
                lastRealProgressAt = Date.now();
                const capped = Math.min(0.95, progress);
                if (capped > modelLoadProgress) {
                  emitModelLoadProgress(capped);
                }
              }
            },
          });
          const runLoadPipeWithProgress = async (timeoutMessage: string): Promise<any> => {
            lastRealProgressAt = Date.now();
            let syntheticProgress = Math.max(0.1, modelLoadProgress);
            const ticker = setInterval(() => {
              syntheticProgress = Math.min(0.95, syntheticProgress + 0.01);
              if (syntheticProgress > modelLoadProgress) {
                emitModelLoadProgress(syntheticProgress);
              }
            }, 900);

            // 停滞检测：若持续无真实进度则提前中止
            let stallReject: ((reason: Error) => void) | null = null;
            const stallPromise = new Promise<never>((_, reject) => { stallReject = reject; });
            const stallChecker = setInterval(() => {
              if (Date.now() - lastRealProgressAt > stallTimeoutMs) {
                stallReject?.(new Error(
                  `[RAG] Download stalled (no progress for ${stallTimeoutMs / 1000}s) on ${host}`,
                ));
              }
            }, 5000);

            try {
              return await Promise.race([
                promiseWithTimeout(loadPipe(), pipelineLoadTimeoutMs, timeoutMessage),
                stallPromise,
              ]);
            } finally {
              clearInterval(ticker);
              clearInterval(stallChecker);
            }
          };
          emitRagModelDebugEvent({ type: 'pipeline-load-start', host, detail: MODEL_NAME });
          let pipe: any;
          try {
            pipe = await runLoadPipeWithProgress(
              `[RAG] Pipeline load timeout (${pipelineLoadTimeoutMs}ms) on ${host}`,
            );
          } catch (err) {
            // 典型场景：曾缓存了 HTML 页面（<!DOCTYPE ...>），会导致 JSON.parse 失败。
            // 清理 transformers-cache 后仅在当前 host 重试一次，避免陷入报错循环。
            if (!shouldResetTransformersCache(err)) throw err;
            console.warn(`[RAG] Invalid cache detected on ${host}, clearing transformers-cache and retrying once...`);
            await clearTransformersCache();
            await ensureModelHostHealth(host);
            emitRagModelDebugEvent({
              type: 'pipeline-load-start',
              host,
              detail: `${MODEL_NAME} (retry-after-cache-clear)`,
            });
            pipe = await runLoadPipeWithProgress(
              `[RAG] Pipeline retry timeout (${pipelineLoadTimeoutMs}ms) on ${host}`,
            );
          }

          emitRagModelDebugEvent({ type: 'pipeline-load-success', host, detail: MODEL_NAME });
          modelLoaded = true;
          emitModelLoadProgress(1);
          emitRagModelDebugEvent({ type: 'model-load-success', host, detail: MODEL_NAME });
          return pipe;
        } catch (err) {
          lastError = err;
          emitRagModelDebugEvent({
            type: 'host-attempt-failed',
            host,
            detail: formatRagDebugDetail(err),
          });
          emitRagModelDebugEvent({
            type: 'pipeline-load-failed',
            host,
            detail: formatRagDebugDetail(err),
          });
          console.warn(`[RAG] Model load failed on host: ${host}`, err);
        }
      }

      const reason = lastError instanceof Error ? lastError.message : String(lastError);
      emitRagModelDebugEvent({
        type: 'model-load-failed',
        detail: `hosts=${hosts.join(', ')} | last=${formatRagDebugDetail(lastError)}`,
      });
      emitModelLoadProgress(0);
      throw new Error(`[RAG] Unable to load embedding model from all hosts (${hosts.join(', ')}). Last error: ${reason}`);
    })().catch((err) => {
      // 加载失败时重置单例，允许下次重试
      embedPipelinePromise = null;
      modelLoaded = false;
      emitModelLoadProgress(0);
      emitRagModelDebugEvent({
        type: 'model-load-failed',
        detail: formatRagDebugDetail(err),
      });
      throw err;
    });
  }
  return embedPipelinePromise;
};

const embedTexts = async (texts: string[], apiConfig?: ApiConfig): Promise<number[][]> => {
  if (apiConfig) return embedTextsViaApi(texts, apiConfig);
  const pipe = await getEmbedPipeline();
  const results: number[][] = [];
  for (const text of texts) {
    const output = await pipe(`passage: ${text}`, { pooling: 'mean', normalize: true });
    results.push(Array.from(output.data as Float32Array));
  }
  return results;
};

const embedQuery = async (query: string, apiConfig?: ApiConfig): Promise<number[]> => {
  if (apiConfig) return embedQueryViaApi(query, apiConfig);
  const pipe = await getEmbedPipeline();
  const output = await pipe(`query: ${query}`, { pooling: 'mean', normalize: true });
  return Array.from(output.data as Float32Array);
};

// ─── API Embedding ───

const buildEmbeddingEndpoint = (apiConfig: ApiConfig): string => {
  const base = (apiConfig.endpoint || '').trim().replace(/\/+$/, '');
  if (apiConfig.provider === 'GEMINI') {
    const model = (apiConfig.model || '').trim();
    return `${base}/models/${model}:batchEmbedContents?key=${encodeURIComponent(apiConfig.apiKey)}`;
  }
  return `${base}/embeddings`;
};

const buildEmbeddingHeaders = (apiConfig: ApiConfig): Record<string, string> => {
  if (apiConfig.provider === 'GEMINI') return { 'Content-Type': 'application/json' };
  if (apiConfig.provider === 'CLAUDE') {
    return {
      'x-api-key': apiConfig.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    };
  }
  return {
    Authorization: `Bearer ${apiConfig.apiKey}`,
    'Content-Type': 'application/json',
  };
};

const embedTextsViaApi = async (texts: string[], apiConfig: ApiConfig): Promise<number[][]> => {
  const model = (apiConfig.model || '').trim();
  if (!model) throw new RagEmbeddingApiError('RAG模型预设中未指定模型名称');

  const url = buildEmbeddingEndpoint(apiConfig);
  const headers = buildEmbeddingHeaders(apiConfig);

  let body: string;
  if (apiConfig.provider === 'GEMINI') {
    body = JSON.stringify({
      requests: texts.map(t => ({
        model: `models/${model}`,
        content: { parts: [{ text: t }] },
      })),
    });
  } else {
    body = JSON.stringify({ model, input: texts });
  }

  let response: Response | null = null;
  let lastNetworkError: unknown = null;
  for (let attempt = 1; attempt <= API_EMBEDDING_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_EMBEDDING_TIMEOUT_MS);
    try {
      response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
      if (response.ok || (response.status !== 408 && response.status !== 429 && response.status < 500)) break;
    } catch (error) {
      lastNetworkError = error;
    } finally {
      clearTimeout(timeoutId);
    }
    if (attempt < API_EMBEDDING_MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    }
  }

  if (!response) {
    const detail = lastNetworkError instanceof Error ? lastNetworkError.message : String(lastNetworkError || '网络错误');
    throw new RagEmbeddingApiError(`Embedding API 请求失败或超时: ${detail}`);
  }

  if (!response.ok) {
    let detail = '';
    try {
      const raw = await response.text();
      const parsed = JSON.parse(raw);
      detail = parsed?.error?.message || parsed?.message || parsed?.detail || raw.slice(0, 200);
    } catch { detail = `HTTP ${response.status}`; }
    throw new RagEmbeddingApiError(
      `Embedding API 调用失败 (${response.status}): ${detail}。请确认“${model}”是 embedding 模型而非对话/生成模型。`,
      response.status,
    );
  }

  const data = await response.json();

  if (apiConfig.provider === 'GEMINI') {
    const embeddings = data?.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
      throw new RagEmbeddingApiError('Gemini embedding 响应格式异常');
    }
    return embeddings.map((e: any) => {
      if (!Array.isArray(e?.values)) throw new RagEmbeddingApiError('Gemini embedding values 缺失');
      const vector = e.values.map(Number);
      if (vector.length === 0 || vector.some((value: number) => !Number.isFinite(value))) {
        throw new RagEmbeddingApiError('Gemini embedding 向量包含无效数值');
      }
      return vector;
    });
  }

  // OpenAI-compatible response
  const items = data?.data;
  if (!Array.isArray(items) || items.length !== texts.length) {
    throw new RagEmbeddingApiError(
      'Embedding 响应格式异常。请确认所选模型是 embedding 模型（如 text-embedding-3-small），而非文本生成模型。'
    );
  }
  const sorted = [...items].sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0));
  const vectors = sorted.map((item: any) => {
    if (!Array.isArray(item.embedding)) {
      throw new RagEmbeddingApiError('Embedding 响应缺少 embedding 数组');
    }
    const vector = item.embedding.map(Number);
    if (vector.length === 0 || vector.some((value: number) => !Number.isFinite(value))) {
      throw new RagEmbeddingApiError('Embedding 响应包含空向量或无效数值');
    }
    return vector;
  });
  const dimensions = vectors[0]?.length || 0;
  if (vectors.some((vector) => vector.length !== dimensions)) {
    throw new RagEmbeddingApiError('Embedding 响应中的向量维度不一致');
  }
  return vectors;
};

const embedQueryViaApi = async (query: string, apiConfig: ApiConfig): Promise<number[]> => {
  const results = await embedTextsViaApi([query], apiConfig);
  return results[0];
};

// ─── 向量相似度 ───

const cosineSimilarity = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  if (a.length === 0 || a.length !== b.length) return -1;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // 已归一化，点积即余弦相似度
};

const selectTopEmbeddingsByScore = (
  embeddings: StoredEmbedding[],
  queryEmbedding: number[],
  topK: number,
  queryTerms: string[],
): (StoredEmbedding & { score: number })[] => {
  if (topK <= 0 || embeddings.length === 0) return [];

  const selected: (StoredEmbedding & { score: number })[] = [];
  for (const embedding of embeddings) {
    const semanticScore = cosineSimilarity(queryEmbedding, embedding.embedding);
    const keywordBoost = computeKeywordBoost(embedding.text, queryTerms);
    const score = semanticScore + keywordBoost * KEYWORD_BOOST_WEIGHT;

    if (selected.length < topK) {
      selected.push({ ...embedding, score });
      if (selected.length === topK) {
        selected.sort((a, b) => b.score - a.score);
      }
      continue;
    }

    if (score <= selected[selected.length - 1].score) continue;

    let insertAt = selected.length - 1;
    while (insertAt > 0 && score > selected[insertAt - 1].score) {
      insertAt--;
    }
    selected.splice(insertAt, 0, { ...embedding, score });
    selected.pop();
  }

  if (selected.length < topK) {
    selected.sort((a, b) => b.score - a.score);
  }

  return selected;
};

// ─── 高层 API ───

export const isBookIndexed = async (bookId: string): Promise<boolean> => {
  try {
    const meta = await getBookMeta(bookId);
    return meta !== null && meta.chunkCount > 0;
  } catch {
    return false;
  }
};

export const getBookIndexedUpTo = async (bookId: string): Promise<number> => {
  try {
    const meta = await getBookMeta(bookId);
    return clampOffset(meta?.indexedUpTo ?? 0, 0);
  } catch {
    return 0;
  }
};

export const shouldBuildBookIndex = async (
  bookId: string,
  chapters: Chapter[],
  maxGlobalOffset: number,
  ragModelPresetId?: string,
  ragApiConfig?: ApiConfig,
): Promise<boolean> => {
  const requestedTargetOffset = clampOffset(maxGlobalOffset, 0);
  if (!bookId || !Array.isArray(chapters) || chapters.length === 0 || requestedTargetOffset <= 0) return false;

  const metrics = getPreparedChapterMetrics(chapters);
  const targetOffset = clampOffsetWithin(requestedTargetOffset, metrics.sanitizedTotalLength, requestedTargetOffset);
  if (targetOffset <= 0) return false;

  try {
    const contentSignature = createChaptersSignature(chapters);
    const meta = await getBookMeta(bookId);
    if (!meta) return true;
    if ((meta.chunkCount || 0) <= 0) return true;
    if (meta.contentSignature !== contentSignature) return true;
    if (meta.ragModelPresetId !== ragModelPresetId) return true;
    if (meta.embeddingModelSignature !== createEmbeddingModelSignature(ragModelPresetId, ragApiConfig)) return true;
    return targetOffset > clampOffset(meta.indexedUpTo || 0, 0);
  } catch {
    // If metadata cannot be read reliably, prefer rebuilding instead of skipping.
    return true;
  }
};

export const indexBookForRag = async (
  bookId: string,
  chapters: Chapter[],
  maxGlobalOffset: number,
  onProgress?: (pct: number) => void,
  ragModelPresetId?: string,
  ragApiConfig?: ApiConfig,
): Promise<void> => {
  if (!bookId || !Array.isArray(chapters) || chapters.length === 0) return;

  const requestedTargetOffset = clampOffset(maxGlobalOffset, 0);
  const metrics = getPreparedChapterMetrics(chapters);
  const targetOffset = clampOffsetWithin(requestedTargetOffset, metrics.sanitizedTotalLength, requestedTargetOffset);
  if (targetOffset <= 0) return;

  const contentSignature = createChaptersSignature(chapters);
  const embeddingModelSignature = createEmbeddingModelSignature(ragModelPresetId, ragApiConfig);
  let meta = await getBookMeta(bookId);

  // 书籍内容发生变化时，重建该书索引，避免旧向量污染检索结果。
  const shouldRebuild =
    !meta ||
    (meta.chunkCount || 0) <= 0 ||
    meta.contentSignature !== contentSignature ||
    meta.ragModelPresetId !== ragModelPresetId ||
    meta.embeddingModelSignature !== embeddingModelSignature;
  if (shouldRebuild) {
    await deleteEmbeddingsByBook(bookId);
    meta = {
      bookId,
      chunkCount: 0,
      indexedUpTo: 0,
      updatedAt: Date.now(),
      contentSignature,
      ragModelPresetId,
      embeddingModelSignature,
    };
  }

  const indexedUpTo = clampOffset(meta.indexedUpTo || 0, 0);
  if (targetOffset <= indexedUpTo) return;

  // API 批次保持保守，兼容常见服务商的单次 input/token 限制。
  const batchSize = ragApiConfig ? API_EMBEDDING_BATCH_SIZE : 8;
  const pendingChunks: TextChunk[] = [];
  let latestOffset = indexedUpTo;
  let persistedCount = Math.max(0, meta.chunkCount || 0);
  const totalDelta = Math.max(1, targetOffset - indexedUpTo);

  const flushChunkBatch = async () => {
    if (pendingChunks.length === 0) return;

    const chunksToFlush = pendingChunks.splice(0, pendingChunks.length);
    const vectors = await embedTexts(chunksToFlush.map((c) => c.text), ragApiConfig);
    if (vectors.length !== chunksToFlush.length) {
      throw new RagEmbeddingApiError(`Embedding 数量不匹配：请求 ${chunksToFlush.length}，返回 ${vectors.length}`);
    }
    const embeddings: StoredEmbedding[] = chunksToFlush.map((chunk, idx) => ({
      chunkId: chunk.id,
      bookId: chunk.bookId,
      chapterIndex: chunk.chapterIndex,
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      text: chunk.text,
      embedding: Float32Array.from(vectors[idx]),
    }));
    await storeEmbeddings(embeddings);
    persistedCount += embeddings.length;
    const checkpointOffset = embeddings.reduce(
      (maxOffset, embedding) => Math.max(maxOffset, embedding.endOffset),
      indexedUpTo,
    );
    await saveBookMeta({
      bookId,
      chunkCount: persistedCount,
      indexedUpTo: checkpointOffset,
      updatedAt: Date.now(),
      contentSignature,
      ragModelPresetId,
      embeddingModelSignature,
    });
    await yieldToMainThread();
  };

  for (const chapter of metrics.chapters) {
    if (chapter.endOffset <= indexedUpTo) continue;
    if (chapter.startOffset >= targetOffset) break;
    const ranges = buildChapterChunkRanges(chapter.text, chapter.startOffset, indexedUpTo, targetOffset);
    for (const range of ranges) {
      const start = chapter.startOffset + range.start;
      const effectiveEnd = chapter.startOffset + range.end;
      const text = chapter.text.slice(range.start, range.end);
      if (text.length < MIN_CHUNK_TEXT_LENGTH) continue;

      pendingChunks.push({
        id: `${bookId}_ch${chapter.chapterIndex}_${range.start}`,
        bookId,
        chapterIndex: chapter.chapterIndex,
        startOffset: start,
        endOffset: effectiveEnd,
        text,
      });
      latestOffset = Math.max(latestOffset, effectiveEnd);

      if (pendingChunks.length >= batchSize) {
        await flushChunkBatch();
        onProgress?.(Math.min(1, Math.max(0, (latestOffset - indexedUpTo) / totalDelta)));
      }
    }
  }

  await flushChunkBatch();
  onProgress?.(1);

  await saveBookMeta({
    bookId,
    chunkCount: persistedCount,
    indexedUpTo: Math.max(indexedUpTo, targetOffset),
    updatedAt: Date.now(),
    contentSignature,
    ragModelPresetId,
    embeddingModelSignature,
  });
};

export const ensureBookIndexedUpTo = async (
  bookId: string,
  chapters: Chapter[],
  maxGlobalOffset: number,
  onProgress?: (pct: number) => void,
  ragModelPresetId?: string,
  ragApiConfig?: ApiConfig,
): Promise<void> => {
  const targetOffset = clampOffset(maxGlobalOffset, 0);
  if (!bookId || !Array.isArray(chapters) || chapters.length === 0 || targetOffset <= 0) return;

  const pending = pendingIndexByBook.get(bookId);
  if (!pending || targetOffset > pending.targetOffset) {
    pendingIndexByBook.set(bookId, { chapters, targetOffset, onProgress, ragModelPresetId, ragApiConfig });
  } else if (pending && chapters !== pending.chapters) {
    pendingIndexByBook.set(bookId, { ...pending, chapters, onProgress: onProgress || pending.onProgress, ragModelPresetId: ragModelPresetId || pending.ragModelPresetId, ragApiConfig: ragApiConfig || pending.ragApiConfig });
  }

  const inFlight = inFlightIndexByBook.get(bookId);
  if (inFlight) return inFlight;

  const task = (async () => {
    while (true) {
      const currentPending = pendingIndexByBook.get(bookId);
      if (!currentPending) break;
      pendingIndexByBook.delete(bookId);

      await indexBookForRag(
        bookId,
        currentPending.chapters,
        currentPending.targetOffset,
        currentPending.onProgress,
        currentPending.ragModelPresetId,
        currentPending.ragApiConfig,
      );

      const nextPending = pendingIndexByBook.get(bookId);
      if (!nextPending || nextPending.targetOffset <= currentPending.targetOffset) break;
    }
  })().finally(() => {
    inFlightIndexByBook.delete(bookId);
  });

  inFlightIndexByBook.set(bookId, task);
  return task;
};

export const retrieveRelevantChunks = async (
  query: string,
  offsetByBookId: Record<string, number>,
  options: RetrieveRelevantChunksOptions = {},
  resolveApiConfig?: (presetId: string | undefined) => ApiConfig | undefined,
): Promise<TextChunk[]> => {
  const topK = Math.max(1, Math.floor(options.topK ?? TOP_K));
  const queryTerms = extractQueryTerms(query);

  const entries = Object.entries(offsetByBookId).filter(([bookId]) => Boolean(bookId));
  const hasExplicitPerBookTopK = typeof options.perBookTopK === 'number';
  const perBookTopK = hasExplicitPerBookTopK
    ? Math.max(1, Math.floor(options.perBookTopK || 1))
    : (entries.length <= 1 ? topK : DEFAULT_PER_BOOK_TOP_K);

  // 按 ragModelPresetId 分组，每组共享同一 query embedding
  const presetGroupMap = new Map<string, string[]>(); // presetKey → bookIds
  const bookPresetMap = new Map<string, string | undefined>(); // bookId → presetId
  for (const [bookId] of entries) {
    let presetId: string | undefined;
    try {
      const meta = await getBookMeta(bookId);
      presetId = meta?.ragModelPresetId;
    } catch { /* 无 meta 视为默认 */ }
    bookPresetMap.set(bookId, presetId);
    const key = presetId || '__local__';
    const group = presetGroupMap.get(key) || [];
    group.push(bookId);
    presetGroupMap.set(key, group);
  }

  // 为每组 embed query（不同模型各 embed 一次）
  const queryEmbeddingCache = new Map<string, number[]>();
  for (const [key, groupBookIds] of presetGroupMap) {
    if (groupBookIds.length === 0) continue;
    const presetId = key === '__local__' ? undefined : key;
    const apiConfig = resolveApiConfig?.(presetId);
    const qe = await embedQuery(query, apiConfig);
    queryEmbeddingCache.set(key, qe);
  }

  const rankedByBook = new Map<string, (StoredEmbedding & { score: number })[]>();

  for (const [bookId, rawMaxOffset] of entries) {
    const maxOffset = Number.isFinite(rawMaxOffset) ? clampOffset(rawMaxOffset, 0) : Infinity;
    if (maxOffset <= 0) continue;

    try {
      const presetId = bookPresetMap.get(bookId);
      const key = presetId || '__local__';
      const queryEmbedding = queryEmbeddingCache.get(key);
      if (!queryEmbedding) continue;

      const bookEmbeddings = await getEmbeddingsByBook(bookId);
      const visibleEmbeddings = bookEmbeddings.filter((e) => e.endOffset <= maxOffset);
      if (visibleEmbeddings.length === 0) continue;

      const ranked = selectTopEmbeddingsByScore(visibleEmbeddings, queryEmbedding, perBookTopK, queryTerms);

      if (ranked.length > 0) rankedByBook.set(bookId, ranked);
    } catch {
      // 跳过无法读取的书
    }
  }

  if (rankedByBook.size === 0) return [];

  // 轮询取样：优先保证多本书都有机会进入上下文，减少“总是同一本同一段”。
  const bookOrder = Array.from(rankedByBook.entries())
    .sort((a, b) => (b[1][0]?.score || -Infinity) - (a[1][0]?.score || -Infinity))
    .map(([bookId]) => bookId);

  const selected: (StoredEmbedding & { score: number })[] = [];
  while (selected.length < topK) {
    let pickedAny = false;
    for (const bookId of bookOrder) {
      if (selected.length >= topK) break;
      const queue = rankedByBook.get(bookId);
      if (!queue || queue.length === 0) continue;
      const next = queue.shift();
      if (!next) continue;
      selected.push(next);
      pickedAny = true;
    }
    if (!pickedAny) break;
  }

  return selected.map((s) => ({
    id: s.chunkId,
    bookId: s.bookId,
    chapterIndex: s.chapterIndex,
    startOffset: s.startOffset,
    endOffset: s.endOffset,
    text: s.text,
  }));
};
