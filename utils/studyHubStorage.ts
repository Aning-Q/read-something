import { Notebook, QuizSession, FavoriteQuote } from '../types';
import { markSyncDataDirty } from './sync/syncSettings';

const DB_NAME = 'app_study_hub_v1';
const DB_VERSION = 2;
const NOTEBOOKS_STORE = 'notebooks';
const QUIZ_SESSIONS_STORE = 'quiz_sessions';
const FAVORITE_QUOTES_STORE = 'favorite_quotes';

let dbPromise: Promise<IDBDatabase> | null = null;
const getUtf8Bytes = (value: string) => new TextEncoder().encode(value).length;

const getSerializedBytes = (value: unknown): number => {
  try {
    return getUtf8Bytes(JSON.stringify(value));
  } catch {
    return 0;
  }
};

const openDb = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(NOTEBOOKS_STORE)) {
        db.createObjectStore(NOTEBOOKS_STORE);
      }
      if (!db.objectStoreNames.contains(QUIZ_SESSIONS_STORE)) {
        db.createObjectStore(QUIZ_SESSIONS_STORE);
      }
      if (!db.objectStoreNames.contains(FAVORITE_QUOTES_STORE)) {
        db.createObjectStore(FAVORITE_QUOTES_STORE);
      }
    };

    request.onblocked = () => {
      // Old connection still open (e.g. HMR); reset and retry on next call
      dbPromise = null;
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error('无法打开共读集数据库'));
    };
  });

  return dbPromise;
};

// ─── Notebook CRUD ───

export const saveNotebook = async (notebook: Notebook): Promise<void> => {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(NOTEBOOKS_STORE, 'readwrite');
    const store = tx.objectStore(NOTEBOOKS_STORE);
    store.put(notebook, notebook.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('保存笔记本失败'));
    tx.onabort = () => reject(tx.error || new Error('保存笔记本失败'));
  });
  markSyncDataDirty();
};

export const getNotebook = async (id: string): Promise<Notebook | null> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(NOTEBOOKS_STORE, 'readonly');
    const store = tx.objectStore(NOTEBOOKS_STORE);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('读取笔记本失败'));
  });
};

export const getAllNotebooks = async (): Promise<Notebook[]> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(NOTEBOOKS_STORE, 'readonly');
    const store = tx.objectStore(NOTEBOOKS_STORE);
    const request = store.getAll();
    request.onsuccess = () => {
      const results = (request.result || []) as Notebook[];
      results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      resolve(results);
    };
    request.onerror = () => reject(request.error || new Error('读取笔记本列表失败'));
  });
};

export const deleteNotebook = async (id: string): Promise<void> => {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(NOTEBOOKS_STORE, 'readwrite');
    const store = tx.objectStore(NOTEBOOKS_STORE);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('删除笔记本失败'));
    tx.onabort = () => reject(tx.error || new Error('删除笔记本失败'));
  });
  markSyncDataDirty();
};

// ─── QuizSession CRUD ───

export const saveQuizSession = async (session: QuizSession): Promise<void> => {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(QUIZ_SESSIONS_STORE, 'readwrite');
    const store = tx.objectStore(QUIZ_SESSIONS_STORE);
    store.put(session, session.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('保存问答会话失败'));
    tx.onabort = () => reject(tx.error || new Error('保存问答会话失败'));
  });
  markSyncDataDirty();
};

export const getQuizSession = async (id: string): Promise<QuizSession | null> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUIZ_SESSIONS_STORE, 'readonly');
    const store = tx.objectStore(QUIZ_SESSIONS_STORE);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('读取问答会话失败'));
  });
};

export const getAllQuizSessions = async (): Promise<QuizSession[]> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUIZ_SESSIONS_STORE, 'readonly');
    const store = tx.objectStore(QUIZ_SESSIONS_STORE);
    const request = store.getAll();
    request.onsuccess = () => {
      const results = (request.result || []) as QuizSession[];
      results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      resolve(results);
    };
    request.onerror = () => reject(request.error || new Error('读取问答会话列表失败'));
  });
};

export const deleteQuizSession = async (id: string): Promise<void> => {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(QUIZ_SESSIONS_STORE, 'readwrite');
    const store = tx.objectStore(QUIZ_SESSIONS_STORE);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('删除问答会话失败'));
    tx.onabort = () => reject(tx.error || new Error('删除问答会话失败'));
  });
  markSyncDataDirty();
};

// ─── FavoriteQuote CRUD ───

export const saveFavoriteQuote = async (quote: FavoriteQuote): Promise<void> => {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(FAVORITE_QUOTES_STORE, 'readwrite');
    const store = tx.objectStore(FAVORITE_QUOTES_STORE);
    store.put(quote, quote.id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('保存收藏消息失败'));
    tx.onabort = () => reject(tx.error || new Error('保存收藏消息失败'));
  });
  markSyncDataDirty();
};

export const getAllFavoriteQuotes = async (): Promise<FavoriteQuote[]> => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FAVORITE_QUOTES_STORE, 'readonly');
    const store = tx.objectStore(FAVORITE_QUOTES_STORE);
    const request = store.getAll();
    request.onsuccess = () => {
      const results = (request.result || []) as FavoriteQuote[];
      results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      resolve(results);
    };
    request.onerror = () => reject(request.error || new Error('读取收藏消息列表失败'));
  });
};

export const deleteFavoriteQuote = async (id: string): Promise<void> => {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(FAVORITE_QUOTES_STORE, 'readwrite');
    const store = tx.objectStore(FAVORITE_QUOTES_STORE);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('删除收藏消息失败'));
    tx.onabort = () => reject(tx.error || new Error('删除收藏消息失败'));
  });
  markSyncDataDirty();
};

// ─── Archive ───

export const exportStudyHubForArchive = async (): Promise<{ notebooks: Notebook[]; quizSessions: QuizSession[]; favoriteQuotes: FavoriteQuote[] }> => {
  const [notebooks, quizSessions, favoriteQuotes] = await Promise.all([getAllNotebooks(), getAllQuizSessions(), getAllFavoriteQuotes()]);
  return { notebooks, quizSessions, favoriteQuotes };
};

export const restoreStudyHubFromArchive = async (payload: { notebooks?: Notebook[]; quizSessions?: QuizSession[]; favoriteQuotes?: FavoriteQuote[] }): Promise<void> => {
  if (!payload) return;
  const db = await openDb();

  await new Promise<void>((resolve, reject) => {
    const storeNames = [NOTEBOOKS_STORE, QUIZ_SESSIONS_STORE, FAVORITE_QUOTES_STORE];
    const tx = db.transaction(storeNames, 'readwrite');
    const nbStore = tx.objectStore(NOTEBOOKS_STORE);
    const qsStore = tx.objectStore(QUIZ_SESSIONS_STORE);
    const fqStore = tx.objectStore(FAVORITE_QUOTES_STORE);

    nbStore.clear();
    qsStore.clear();
    fqStore.clear();

    if (Array.isArray(payload.notebooks)) {
      payload.notebooks.forEach((nb) => { if (nb && nb.id) nbStore.put(nb, nb.id); });
    }
    if (Array.isArray(payload.quizSessions)) {
      payload.quizSessions.forEach((qs) => { if (qs && qs.id) qsStore.put(qs, qs.id); });
    }
    if (Array.isArray(payload.favoriteQuotes)) {
      payload.favoriteQuotes.forEach((fq) => { if (fq && fq.id) fqStore.put(fq, fq.id); });
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('恢复共读集数据失败'));
    tx.onabort = () => reject(tx.error || new Error('恢复共读集数据失败'));
  });
  markSyncDataDirty();
};

export const getStudyHubStorageUsageBytes = async (): Promise<{
  notebooksBytes: number;
  quizSessionsBytes: number;
  favoriteQuotesBytes: number;
  totalBytes: number;
}> => {
  const [notebooks, quizSessions, favoriteQuotes] = await Promise.all([getAllNotebooks(), getAllQuizSessions(), getAllFavoriteQuotes()]);
  const notebooksBytes = notebooks.reduce((sum, item) => sum + getSerializedBytes(item), 0);
  const quizSessionsBytes = quizSessions.reduce((sum, item) => sum + getSerializedBytes(item), 0);
  const favoriteQuotesBytes = favoriteQuotes.reduce((sum, item) => sum + getSerializedBytes(item), 0);

  return {
    notebooksBytes,
    quizSessionsBytes,
    favoriteQuotesBytes,
    totalBytes: notebooksBytes + quizSessionsBytes + favoriteQuotesBytes,
  };
};
