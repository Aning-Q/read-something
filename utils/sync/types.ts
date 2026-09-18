export type SyncProviderId = 'gist' | 'supabase';

/**
 * pull / push / both 是用户显式发起的操作；
 * auto 用于启动时自动检查，只有在云端确实更新时才下载，且不会上传。
 */
export type SyncDirection = 'pull' | 'push' | 'both' | 'auto' | 'auto-push';

export interface SyncWarning {
  type: 'size_limit' | 'partial_data' | 'conflict' | 'encryption';
  message: string;
  detail?: string;
}

export interface SyncResult {
  success: boolean;
  error?: string;
  pulled?: number;
  pushed?: number;
  conflicts?: string[];
  warnings?: SyncWarning[];
  remoteSyncedAt?: number;
  versionId?: string;
}

export interface SyncConnectionSettings {
  provider: SyncProviderId;
  enabled: boolean;
  autoSync: boolean;
  lastSyncedAt: number;
  lastRemoteSyncedAt: number;
  clientId: string;
  deviceLabel: string;

  // 同步内容范围
  includeBookContents: boolean;
  includeImages: boolean;
  includeTtsAudio: boolean;

  // GitHub Gist
  githubToken: string;
  gistId: string;
  proxyUrl: string;
  useProxy: boolean;

  // Supabase
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseEmail: string;
  supabasePassword: string;
  supabaseRefreshToken: string;
  supabaseBucket: string;
  supabaseUserId: string;

  // 客户端加密
  syncPassword: string;

  // 保留的历史版本数量
  keepVersions: number;
}

export interface SyncVersionEntry {
  id: string;
  createdAt: number;
  syncedAt: number;
  deviceLabel: string;
  clientId: string;
  sizeBytes: number;
  encrypted: boolean;
  objectName: string;
}

export interface SyncManifest {
  schema: string;
  schemaVersion: number;
  appId: string;
  updatedAt: number;
  latestVersionId: string | null;
  latestObjectName: string;
  versions: SyncVersionEntry[];
}

export interface SyncPayloadMeta {
  schema: string;
  schemaVersion: number;
  appId: string;
  clientId: string;
  deviceLabel: string;
  syncedAt: number;
  encrypted: boolean;
  includeBookContents: boolean;
  includeImages: boolean;
  includeTtsAudio: boolean;
}

export const SYNC_SETTINGS_KEY = 'app_sync_settings';
export const SYNC_STATE_KEY = 'app_sync_state';
export const SYNC_CLIENT_ID_KEY = 'app_sync_client_id';
export const LEGACY_GIST_SETTINGS_KEY = 'app_gist_sync_settings';
export const LEGACY_CLIENT_ID_KEY = 'app_gist_sync_client_id';

export const SYNC_OWNED_LOCAL_STORAGE_KEYS = [
  SYNC_SETTINGS_KEY,
  SYNC_STATE_KEY,
  SYNC_CLIENT_ID_KEY,
  LEGACY_GIST_SETTINGS_KEY,
  LEGACY_CLIENT_ID_KEY,
];

export const SYNC_MANIFEST_OBJECT = 'manifest.json';
export const SYNC_VERSION_PREFIX = 'versions/';

export const SYNC_MANIFEST_SCHEMA = 'read-something-sync-manifest';
export const SYNC_PAYLOAD_SCHEMA = 'read-something-sync-payload';
export const SYNC_MANIFEST_SCHEMA_VERSION = 1;
export const SYNC_PAYLOAD_SCHEMA_VERSION = 1;
export const SYNC_APP_ID = 'ai-reader-companion';

export const DEFAULT_SUPABASE_BUCKET = 'read-something-sync';

export class SyncError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'SyncError';
  }
}

export const DEFAULT_SYNC_SETTINGS: SyncConnectionSettings = {
  provider: 'supabase',
  enabled: false,
  autoSync: true,
  lastSyncedAt: 0,
  lastRemoteSyncedAt: 0,
  clientId: '',
  deviceLabel: '',

  includeBookContents: true,
  includeImages: false,
  includeTtsAudio: false,

  githubToken: '',
  gistId: '',
  proxyUrl: '',
  useProxy: true,

  supabaseUrl: '',
  supabaseAnonKey: '',
  supabaseEmail: '',
  supabasePassword: '',
  supabaseRefreshToken: '',
  supabaseBucket: DEFAULT_SUPABASE_BUCKET,
  supabaseUserId: '',

  syncPassword: '',

  keepVersions: 5,
};
