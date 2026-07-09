export interface GistSyncSettings {
  enabled: boolean;
  githubToken: string;
  gistId: string;
  autoSync: boolean;
  syncImages: boolean;
  lastSyncedAt: number;
  // CORS 代理设置 (为空则直连 GitHub)
  proxyUrl: string;
  useProxy: boolean;
}

export interface SyncEntityMeta {
  id: string;
  lastModified: number;
}

export interface StoredBookContent {
  fullText: string;
  chapters: Array<{ title: string; content: string }>;
}

// 同步结果：警告信息
export interface SyncWarning {
  type: 'size_limit' | 'partial_data';
  message: string;
  detail?: string;
}

export interface SyncSnapshot {
  schemaVersion: 2;
  clientId: string;
  syncedAt: number;
  
  // LocalStorage 数据 (书籍列表、设置、API配置等)
  localStorage: Record<string, string>;
  
  // IndexedDB 数据
  bookContents: Record<string, StoredBookContent>;  // 书籍全文
  chatHistory: Record<string, unknown>;            // AI 对话历史
  
  // StudyHub 数据 (共读集：笔记、测验、收藏语录)
  studyHub: {
    notebooks: unknown[];
    quizSessions: unknown[];
    favoriteQuotes: unknown[];
  };
  
  // 可选的图片数据 (base64)
  images?: Record<string, string>;
}

export interface SyncResult {
  success: boolean;
  error?: string;
  pulled?: number;
  pushed?: number;
  conflicts?: string[];
  warnings?: SyncWarning[];
}

export type SyncDirection = 'pull' | 'push' | 'both';

export const GIST_SETTINGS_KEY = 'app_gist_sync_settings';
export const GIST_FILENAME = 'read-something-sync.json';
export const GIST_DESCRIPTION = 'Read Something - Cross-device sync data (PRIVATE)';
export const CLIENT_ID_KEY = 'app_gist_sync_client_id';

// 要同步的 localStorage key 白名单
export const SYNC_LOCALSTORAGE_KEYS = [
  'app_books',
  'app_api_config',
  'app_api_presets',
  'app_rag_presets',
  'app_active_rag_preset_id',
  'app_tts_config',
  'app_tts_presets',
  'app_settings',
  'app_personas',
  'app_characters',
  'app_worldbook',
  'app_wb_categories',
  'app_user_signature',
  'app_active_persona_id',
  'app_active_character_id',
  'app_dark_mode',
  'app_daily_reading_ms',
  'app_completed_book_ids',
  'app_completed_book_reached_at',
  'app_reading_ms_by_book_id',
];
