export interface GistSyncSettings {
  enabled: boolean;
  githubToken: string;
  gistId: string;
  autoSync: boolean;
  syncImages: boolean;
  lastSyncedAt: number;
}

export interface SyncEntityMeta {
  id: string;
  lastModified: number;
}

export interface SyncSnapshot {
  schemaVersion: 1;
  clientId: string;
  syncedAt: number;
  
  // LocalStorage 数据
  localStorage: Record<string, string>;
  
  // IndexedDB 元数据 (不包含书籍全文和图片)
  studyHub: {
    notebooks: SyncEntityMeta[];
    quizSessions: SyncEntityMeta[];
    favoriteQuotes: SyncEntityMeta[];
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
