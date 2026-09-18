import {
  DEFAULT_SYNC_SETTINGS,
  SYNC_SETTINGS_KEY,
  SYNC_CLIENT_ID_KEY,
  SYNC_STATE_KEY,
  LEGACY_GIST_SETTINGS_KEY,
  LEGACY_CLIENT_ID_KEY,
  SyncConnectionSettings,
  SyncProviderId,
} from './types';

export interface SyncLocalState {
  lastSyncedAt: number;
  lastRemoteSyncedAt: number;
  /** 上次成功同步后对应的云端版本，用于发现另一台设备是否又上传过。 */
  lastVersionId: string;
  /** 当前本机从上次成功同步后是否发生过修改。 */
  localDirty: boolean;
  /** 同步目标变化时不能沿用旧服务/旧账号的比较基准。 */
  targetKey: string;
  lastError: string;
  lastResult: string;
}

const safeParse = (raw: string | null): Record<string, unknown> | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const readLegacyGistSettings = (): Record<string, unknown> | null => {
  try {
    return safeParse(localStorage.getItem(LEGACY_GIST_SETTINGS_KEY));
  } catch {
    return null;
  }
};

const randomClientId = (): string =>
  `client_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

/** 首次读取时生成稳定的设备标识，用于判断「这份存档是不是本机推的」。 */
export const ensureClientId = (): string => {
  try {
    const existing = localStorage.getItem(SYNC_CLIENT_ID_KEY);
    if (existing) return existing;
    // 从旧版 Gist 同步迁移，避免升级后旧设备被当成新设备。
    const legacy = localStorage.getItem(LEGACY_CLIENT_ID_KEY);
    const clientId = legacy || randomClientId();
    localStorage.setItem(SYNC_CLIENT_ID_KEY, clientId);
    return clientId;
  } catch {
    return randomClientId();
  }
};

export const guessDeviceLabel = (): string => {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android 设备';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows 电脑';
  if (/Linux/i.test(ua)) return 'Linux 设备';
  return '未知设备';
};

/**
 * 读取同步设置。首次调用时会吸收旧版 app_gist_sync_settings，
 * 让已经配置过 Gist 的用户升级后不用重新填写 Token。
 */
export const getSyncSettings = (): SyncConnectionSettings => {
  const stored = (() => {
    try {
      return safeParse(localStorage.getItem(SYNC_SETTINGS_KEY));
    } catch {
      return null;
    }
  })();
  const legacy = readLegacyGistSettings();

  const merged: SyncConnectionSettings = {
    ...DEFAULT_SYNC_SETTINGS,
    ...(legacy
      ? {
          enabled: Boolean(legacy.enabled),
          autoSync: legacy.autoSync !== false,
          githubToken: typeof legacy.githubToken === 'string' ? legacy.githubToken : '',
          gistId: typeof legacy.gistId === 'string' ? legacy.gistId : '',
          proxyUrl: typeof legacy.proxyUrl === 'string' ? legacy.proxyUrl : '',
          useProxy: legacy.useProxy !== false,
          lastSyncedAt: Number(legacy.lastSyncedAt) || 0,
          provider: 'gist' as SyncProviderId,
        }
      : {}),
    ...(stored ?? {}),
  };

  merged.clientId = ensureClientId();
  if (!merged.deviceLabel) merged.deviceLabel = guessDeviceLabel();
  if (!Number.isFinite(merged.keepVersions) || merged.keepVersions < 1) merged.keepVersions = 5;
  if (merged.provider !== 'supabase' && merged.provider !== 'gist') {
    merged.provider = DEFAULT_SYNC_SETTINGS.provider;
  }
  // Supabase 登录密码只允许在组件内存中短暂存在；登录态由刷新令牌延续。
  merged.supabasePassword = '';
  return merged;
};

export const saveSyncSettings = (patch: Partial<SyncConnectionSettings>): SyncConnectionSettings => {
  const next = { ...getSyncSettings(), ...patch };
  const { supabasePassword: _passwordDraft, ...persisted } = next;
  try {
    localStorage.setItem(SYNC_SETTINGS_KEY, JSON.stringify(persisted));
  } catch {
    // localStorage 不可用时保持内存态，不阻断同步流程
  }
  return next;
};

export const clearSyncSettings = (): void => {
  try {
    localStorage.removeItem(SYNC_SETTINGS_KEY);
    localStorage.removeItem(LEGACY_GIST_SETTINGS_KEY);
  } catch {
    // ignore
  }
};

const readState = (): Record<string, unknown> | null => {
  try {
    return safeParse(localStorage.getItem(SYNC_STATE_KEY));
  } catch {
    return null;
  }
};

export const getSyncState = (): SyncLocalState => {
  const raw = readState() ?? {};
  return {
    lastSyncedAt: Number(raw.lastSyncedAt) || 0,
    lastRemoteSyncedAt: Number(raw.lastRemoteSyncedAt) || 0,
    lastVersionId: typeof raw.lastVersionId === 'string' ? raw.lastVersionId : '',
    localDirty: raw.localDirty === true,
    targetKey: typeof raw.targetKey === 'string' ? raw.targetKey : '',
    lastError: typeof raw.lastError === 'string' ? raw.lastError : '',
    lastResult: typeof raw.lastResult === 'string' ? raw.lastResult : '',
  };
};

export const saveSyncState = (patch: Partial<SyncLocalState>): SyncLocalState => {
  const next = { ...getSyncState(), ...patch };
  try {
    localStorage.setItem(SYNC_STATE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
};

let dirtyTrackingSuspended = 0;

/** IndexedDB 写入点调用它，通知应用安排一次防抖同步。 */
export const markSyncDataDirty = (): void => {
  if (dirtyTrackingSuspended > 0) return;
  saveSyncState({ localDirty: true });
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('app-sync-data-changed'));
  }
};

/** 云端恢复会批量写 IndexedDB，这些写入本身不应再次被当成本机编辑。 */
export const withSyncDirtyTrackingSuspended = async <T>(operation: () => Promise<T>): Promise<T> => {
  dirtyTrackingSuspended += 1;
  try {
    return await operation();
  } finally {
    dirtyTrackingSuspended = Math.max(0, dirtyTrackingSuspended - 1);
  }
};

export const formatSyncTime = (timestamp: number): string => {
  if (!timestamp) return '从未同步';
  const date = new Date(timestamp);
  const pad = (value: number) => `${value}`.padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
