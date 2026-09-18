import {
  DEFAULT_SUPABASE_BUCKET,
  SyncConnectionSettings,
  SyncError,
  SyncManifest,
  SyncVersionEntry,
  SYNC_APP_ID,
  SYNC_MANIFEST_OBJECT,
  SYNC_MANIFEST_SCHEMA,
  SYNC_MANIFEST_SCHEMA_VERSION,
  SYNC_VERSION_PREFIX,
} from './types';
import { RemoteObjectPayload, SyncProvider } from './provider';
import { saveSyncSettings } from './syncSettings';

const REQUEST_TIMEOUT_MS = 60_000;
const FILE_TRANSFER_TIMEOUT_MS = 5 * 60_000;

interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  userId: string;
  expiresAt: number;
}

/**
 * 缓存登录令牌。
 * Supabase 会在每次刷新时轮换 refresh token，短时间内重复刷新有被判定为
 * 令牌复用的风险，因此同一账号在有效期内复用同一份会话。
 */
let cachedSession: { key: string; tokens: SessionTokens } | null = null;

const sessionCacheKey = (settings: SyncConnectionSettings): string =>
  `${normalizeUrl(settings.supabaseUrl || '')}::${settings.supabaseUserId || settings.supabaseEmail || ''}`;

const isSessionFresh = (tokens: SessionTokens): boolean => tokens.expiresAt - Date.now() > 60_000;

const normalizeUrl = (raw: string): string => raw.trim().replace(/\/+$/, '');

const requireConfig = (settings: SyncConnectionSettings): { url: string; anonKey: string; bucket: string } => {
  const url = normalizeUrl(settings.supabaseUrl || '');
  const anonKey = (settings.supabaseAnonKey || '').trim();
  if (!url) throw new SyncError('请先填写 Supabase 项目地址');
  if (!/^https?:\/\//i.test(url)) throw new SyncError('Supabase 项目地址需要以 https:// 开头');
  if (!anonKey) throw new SyncError('请先填写 Supabase anon key');
  return { url, anonKey, bucket: (settings.supabaseBucket || DEFAULT_SUPABASE_BUCKET).trim() };
};

const request = async (
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> => {
  const controller = new AbortController();
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...fetchInit } = init;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...fetchInit, signal: controller.signal });
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new SyncError('请求超时，请检查网络后重试');
    }
    if (error instanceof SyncError) throw error;
    throw new SyncError('网络连接失败，请检查网络后重试');
  } finally {
    clearTimeout(timer);
  }
};

const readErrorBody = async (response: Response): Promise<string> => {
  try {
    const text = await response.text();
    if (!text) return '';
    try {
      const parsed = JSON.parse(text);
      const message = parsed?.message || parsed?.error_description || parsed?.error || parsed?.msg;
      if (typeof message === 'string' && message) return message;
    } catch {
      // 非 JSON 错误体，直接返回原文
    }
    return text.slice(0, 300);
  } catch {
    return '';
  }
};

const signInWithPassword = async (
  settings: SyncConnectionSettings
): Promise<SessionTokens> => {
  const { url, anonKey } = requireConfig(settings);
  const email = (settings.supabaseEmail || '').trim();
  const password = settings.supabasePassword || '';
  if (!email) throw new SyncError('请先填写登录邮箱');
  if (!password) throw new SyncError('请先填写登录密码');

  const response = await request(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    const detail = await readErrorBody(response);
    if (response.status === 400 || response.status === 401) {
      throw new SyncError(`登录失败：邮箱或密码不正确${detail ? `（${detail}）` : ''}`);
    }
    throw new SyncError(`登录失败：${detail || response.status}`);
  }
  const data = await response.json();
  if (!data?.access_token || !data?.user?.id) {
    throw new SyncError('登录响应缺少令牌，请确认项目已开启邮箱登录');
  }
  saveSyncSettings({
    supabaseRefreshToken: data.refresh_token || '',
    supabaseUserId: data.user.id,
  });
  // 调用方可能持有设置页中的旧对象；同步更新它，避免令牌轮换后再次使用旧 refresh token。
  settings.supabaseRefreshToken = data.refresh_token || '';
  settings.supabaseUserId = data.user.id;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || '',
    userId: data.user.id,
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000,
  };
};

const refreshSession = async (settings: SyncConnectionSettings): Promise<SessionTokens> => {
  const { url, anonKey } = requireConfig(settings);
  const refreshToken = (settings.supabaseRefreshToken || '').trim();
  if (!refreshToken) throw new SyncError('登录状态已过期，请重新输入邮箱和密码');

  const response = await request(`${url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!response.ok) {
    saveSyncSettings({ supabaseRefreshToken: '' });
    settings.supabaseRefreshToken = '';
    throw new SyncError('登录状态已过期，请重新输入邮箱和密码');
  }
  const data = await response.json();
  if (!data?.access_token || !data?.user?.id) {
    throw new SyncError('刷新登录状态失败，请重新登录');
  }
  saveSyncSettings({ supabaseRefreshToken: data.refresh_token || refreshToken, supabaseUserId: data.user.id });
  settings.supabaseRefreshToken = data.refresh_token || refreshToken;
  settings.supabaseUserId = data.user.id;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    userId: data.user.id,
    expiresAt: Date.now() + Math.max(60, Number(data.expires_in) || 3600) * 1000,
  };
};

/** 优先复用刷新令牌，失效时再用邮箱密码换新令牌。 */
const getSession = async (settings: SyncConnectionSettings): Promise<SessionTokens> => {
  const key = sessionCacheKey(settings);
  if (cachedSession && cachedSession.key === key && isSessionFresh(cachedSession.tokens)) {
    return cachedSession.tokens;
  }

  const tokens = settings.supabaseRefreshToken
    ? await refreshSession(settings).catch(() => signInWithPassword(settings))
    : await signInWithPassword(settings);
  cachedSession = { key, tokens };
  return tokens;
};

/** 令牌失效时清掉缓存，让下一次调用重新登录。 */
const invalidateSession = (): void => {
  cachedSession = null;
};

const buildObjectPath = (userId: string, objectName: string): string => `${userId}/${objectName}`;

const uploadObject = async (
  settings: SyncConnectionSettings,
  session: SessionTokens,
  objectName: string,
  blob: Blob
): Promise<void> => {
  const { url, anonKey, bucket } = requireConfig(settings);
  const response = await request(
    `${url}/storage/v1/object/${encodeURIComponent(bucket)}/${buildObjectPath(session.userId, objectName)}`,
    {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${session.accessToken}`,
        'Content-Type': blob.type || 'application/octet-stream',
        'x-upsert': 'true',
        'cache-control': 'no-cache',
      },
      body: blob,
      timeoutMs: FILE_TRANSFER_TIMEOUT_MS,
    }
  );
  if (!response.ok) {
    const detail = await readErrorBody(response);
    if (response.status === 401) invalidateSession();
    if (response.status === 403) {
      throw new SyncError(`上传被拒绝：请检查存储桶策略是否允许当前用户写入（${detail || '403'}）`);
    }
    if (response.status === 404) {
      throw new SyncError(`存储桶 ${bucket} 不存在，请先按说明创建`);
    }
    if (response.status === 413) {
      throw new SyncError('存档超过 Supabase 当前项目允许的单文件大小，请提高 Storage 限制或减少同步内容');
    }
    throw new SyncError(`上传失败：${detail || response.status}`);
  }
};

const downloadObject = async (
  settings: SyncConnectionSettings,
  session: SessionTokens,
  objectName: string
): Promise<RemoteObjectPayload | null> => {
  const { url, anonKey, bucket } = requireConfig(settings);
  const response = await request(
    `${url}/storage/v1/object/${encodeURIComponent(bucket)}/${buildObjectPath(session.userId, objectName)}`,
    {
      method: 'GET',
      headers: { apikey: anonKey, Authorization: `Bearer ${session.accessToken}` },
      timeoutMs: FILE_TRANSFER_TIMEOUT_MS,
    }
  );
  if (response.status === 404 || response.status === 400) return null;
  if (!response.ok) {
    if (response.status === 401) invalidateSession();
    const detail = await readErrorBody(response);
    throw new SyncError(`下载失败：${detail || response.status}`);
  }
  const blob = await response.blob();
  const lastModified = response.headers.get('last-modified');
  const updatedAt = lastModified ? new Date(lastModified).getTime() : Date.now();
  return { blob, updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now() };
};

const listObjects = async (
  settings: SyncConnectionSettings,
  session: SessionTokens,
  prefix: string
): Promise<string[]> => {
  const { url, anonKey, bucket } = requireConfig(settings);
  const response = await request(`${url}/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prefix: buildObjectPath(session.userId, prefix),
      limit: 200,
      offset: 0,
      sortBy: { column: 'name', order: 'desc' },
    }),
  });
  if (!response.ok) {
    if (response.status === 401) invalidateSession();
    const detail = await readErrorBody(response);
    throw new SyncError(`读取远端列表失败：${detail || response.status}`);
  }
  const entries = await response.json();
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => (entry && typeof entry.name === 'string' ? entry.name : ''))
    .filter(Boolean)
    .map((name) => `${prefix}${name}`);
};

const deleteObjects = async (
  settings: SyncConnectionSettings,
  session: SessionTokens,
  objectNames: string[]
): Promise<void> => {
  if (objectNames.length === 0) return;
  const { url, anonKey, bucket } = requireConfig(settings);
  const response = await request(`${url}/storage/v1/object/${encodeURIComponent(bucket)}`, {
    method: 'DELETE',
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${session.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prefixes: objectNames.map((name) => buildObjectPath(session.userId, name)),
    }),
  });
  if (!response.ok && response.status !== 404) {
    if (response.status === 401) invalidateSession();
    const detail = await readErrorBody(response);
    throw new SyncError(`清理历史版本失败：${detail || response.status}`);
  }
};

const emptyManifest = (): SyncManifest => ({
  schema: SYNC_MANIFEST_SCHEMA,
  schemaVersion: SYNC_MANIFEST_SCHEMA_VERSION,
  appId: SYNC_APP_ID,
  updatedAt: 0,
  latestVersionId: null,
  latestObjectName: '',
  versions: [],
});

const normalizeManifest = (raw: unknown): SyncManifest => {
  if (!raw || typeof raw !== 'object') throw new SyncError('云端同步清单格式无效');
  const source = raw as Record<string, unknown>;
  if (source.schema !== SYNC_MANIFEST_SCHEMA || source.appId !== SYNC_APP_ID) {
    throw new SyncError('云端同步清单不属于当前应用，已停止覆盖');
  }
  const schemaVersion = Number(source.schemaVersion) || 0;
  if (schemaVersion > SYNC_MANIFEST_SCHEMA_VERSION) {
    throw new SyncError('云端同步清单来自更高版本的应用，请先更新当前应用');
  }
  const versions: SyncVersionEntry[] = Array.isArray(source.versions)
    ? source.versions
        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .map((item) => ({
          id: typeof item.id === 'string' ? item.id : '',
          createdAt: Number(item.createdAt) || 0,
          syncedAt: Number(item.syncedAt) || 0,
          deviceLabel: typeof item.deviceLabel === 'string' ? item.deviceLabel : '',
          clientId: typeof item.clientId === 'string' ? item.clientId : '',
          sizeBytes: Number(item.sizeBytes) || 0,
          encrypted: item.encrypted === true,
          objectName: typeof item.objectName === 'string' ? item.objectName : '',
        }))
        .filter((item) => item.id && item.objectName)
    : [];
  return {
    ...emptyManifest(),
    updatedAt: Number(source.updatedAt) || 0,
    latestVersionId: typeof source.latestVersionId === 'string' ? source.latestVersionId : null,
    latestObjectName: typeof source.latestObjectName === 'string' ? source.latestObjectName : '',
    versions,
  };
};

const buildVersionName = (syncedAt: number, clientId: string): string =>
  `${SYNC_VERSION_PREFIX}${syncedAt}-${(clientId || 'device').slice(-8)}.bin`;

export const supabaseProvider: SyncProvider = {
  id: 'supabase',
  label: 'Supabase',

  validateSettings(settings) {
    if (!(settings.supabaseUrl || '').trim()) return '请填写 Supabase 项目地址';
    if (!(settings.supabaseAnonKey || '').trim()) return '请填写 Supabase anon key';
    if (!(settings.supabaseEmail || '').trim()) return '请填写登录邮箱';
    if (!settings.supabaseRefreshToken && !settings.supabasePassword) {
      return '请填写登录密码，或先完成一次登录';
    }
    if (!settings.syncPassword) return '请设置同步密码，用于加密云端存档';
    return null;
  },

  async testConnection(settings) {
    const session = await getSession(settings);
    // 用一次轻量列表请求确认存储桶可访问，比只验证登录更接近真实同步场景。
    await listObjects(settings, session, SYNC_VERSION_PREFIX);
  },

  async readManifest(settings) {
    const session = await getSession(settings);
    const remote = await downloadObject(settings, session, SYNC_MANIFEST_OBJECT);
    if (!remote) return emptyManifest();
    try {
      return normalizeManifest(JSON.parse(await remote.blob.text()));
    } catch (error) {
      if (error instanceof SyncError) throw error;
      throw new SyncError('云端同步清单已损坏，已停止覆盖；请检查或备份后删除 manifest.json');
    }
  },

  async writeManifest(settings, manifest) {
    const session = await getSession(settings);
    const blob = new Blob([JSON.stringify(manifest)], { type: 'application/json' });
    await uploadObject(settings, session, SYNC_MANIFEST_OBJECT, blob);
  },

  async uploadPayload(settings, blob, info) {
    const session = await getSession(settings);
    // 只写一份带时间戳的版本对象，清单里的 latestObjectName 指向它。
    // 额外复制一份 latest.bin 会让每份存档占用双倍空间，因此不做冗余。
    const objectName = buildVersionName(info.syncedAt, settings.clientId);
    await uploadObject(settings, session, objectName, blob);
    return {
      id: `${info.syncedAt}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      syncedAt: info.syncedAt,
      deviceLabel: settings.deviceLabel,
      clientId: settings.clientId,
      sizeBytes: blob.size,
      encrypted: info.encrypted,
      objectName,
    };
  },

  async downloadPayload(settings, objectName) {
    const session = await getSession(settings);
    const remote = await downloadObject(settings, session, objectName);
    if (!remote) throw new SyncError('云端存档不存在，可能已被删除');
    return remote;
  },

  async deleteObjects(settings, objectNames) {
    if (objectNames.length === 0) return;
    const session = await getSession(settings);
    await deleteObjects(settings, session, objectNames);
  },
};
