import {
  GistApiError,
  createGistWithFiles,
  findGistByFileName,
  getGistFileMap,
  testToken,
  updateGistFiles,
} from './gistApi';
import {
  SyncConnectionSettings,
  SyncError,
  SyncManifest,
  SyncVersionEntry,
  SYNC_APP_ID,
  SYNC_MANIFEST_SCHEMA,
  SYNC_MANIFEST_SCHEMA_VERSION,
} from './types';
import { RemoteObjectPayload, SyncProvider } from './provider';
import { saveSyncSettings } from './syncSettings';

const MANIFEST_FILE_NAME = 'read-something-manifest.json';
const PAYLOAD_FILE_NAME = 'read-something-latest.b64';
const GIST_DESCRIPTION = 'Read Something - Cross-device sync data (PRIVATE)';

/**
 * GitHub Gist 上限约 1MB。Base64 会放大约三分之一，
 * 因此明文可用体积取 700KB，为编码和清单留出余量。
 */
const GIST_SAFE_PAYLOAD_BYTES = 700 * 1024;

const requireToken = (settings: SyncConnectionSettings): string => {
  const token = (settings.githubToken || '').trim();
  if (!token) throw new SyncError('请先填写 GitHub Token');
  return token;
};

const applyProxy = (settings: SyncConnectionSettings): void => {
  const useProxy = settings.useProxy && settings.proxyUrl;
  (globalThis as { __gist_proxy_url?: string }).__gist_proxy_url = useProxy
    ? settings.proxyUrl.trim()
    : undefined;
};

const wrapGistError = (error: unknown, fallback: string): never => {
  if (error instanceof GistApiError) throw new SyncError(error.message, `gist_${error.statusCode ?? 0}`);
  if (error instanceof SyncError) throw error;
  throw new SyncError(error instanceof Error ? error.message : fallback);
};

const blobToBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
};

const base64ToBlob = (base64: string): Blob => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: 'application/octet-stream' });
};

const emptyManifest = (): SyncManifest => ({
  schema: SYNC_MANIFEST_SCHEMA,
  schemaVersion: SYNC_MANIFEST_SCHEMA_VERSION,
  appId: SYNC_APP_ID,
  updatedAt: 0,
  latestVersionId: null,
  latestObjectName: PAYLOAD_FILE_NAME,
  versions: [],
});

/** 定位同步 Gist：优先用已保存的 id，否则按文件名在账号里查找。 */
const resolveGistId = async (
  settings: SyncConnectionSettings,
  token: string
): Promise<string> => {
  if (settings.gistId) return settings.gistId;
  const found = (await findGistByFileName(token, MANIFEST_FILE_NAME))
    || (await findGistByFileName(token, PAYLOAD_FILE_NAME));
  if (found) {
    saveSyncSettings({ gistId: found });
    return found;
  }
  return '';
};

export const gistProvider: SyncProvider = {
  id: 'gist',
  label: 'GitHub Gist',

  validateSettings(settings) {
    if (!(settings.githubToken || '').trim()) return '请填写 GitHub Token';
    if (!settings.syncPassword) return '请设置同步密码，用于加密云端存档';
    return null;
  },

  async testConnection(settings) {
    applyProxy(settings);
    try {
      await testToken(requireToken(settings));
    } catch (error) {
      wrapGistError(error, 'GitHub 连接失败');
    }
  },

  async readManifest(settings) {
    applyProxy(settings);
    const token = requireToken(settings);
    try {
      const gistId = await resolveGistId(settings, token);
      if (!gistId) return emptyManifest();
      const files = await getGistFileMap(token, gistId);
      const raw = files[MANIFEST_FILE_NAME];
      if (!raw) return emptyManifest();
      const parsed = JSON.parse(raw) as Partial<SyncManifest>;
      if (parsed.schema !== SYNC_MANIFEST_SCHEMA || parsed.appId !== SYNC_APP_ID) {
        throw new SyncError('Gist 中的同步清单不属于当前应用，已停止覆盖');
      }
      if (Number(parsed.schemaVersion) > SYNC_MANIFEST_SCHEMA_VERSION) {
        throw new SyncError('Gist 同步清单来自更高版本的应用，请先更新当前应用');
      }
      const manifest: SyncManifest = { ...emptyManifest(), ...parsed };
      manifest.versions = Array.isArray(manifest.versions) ? manifest.versions : [];
      return manifest;
    } catch (error) {
      wrapGistError(error, '读取 Gist 清单失败');
    }
  },

  async writeManifest(settings, manifest) {
    applyProxy(settings);
    const token = requireToken(settings);
    try {
      const gistId = await resolveGistId(settings, token);
      const content = JSON.stringify(manifest);
      if (!gistId) {
        const created = await createGistWithFiles(token, GIST_DESCRIPTION, {
          [MANIFEST_FILE_NAME]: content,
        });
        saveSyncSettings({ gistId: created });
        return;
      }
      await updateGistFiles(token, gistId, { [MANIFEST_FILE_NAME]: content });
    } catch (error) {
      wrapGistError(error, '写入 Gist 清单失败');
    }
  },

  async uploadPayload(settings, blob, info) {
    applyProxy(settings);
    const token = requireToken(settings);
    if (blob.size > GIST_SAFE_PAYLOAD_BYTES) {
      throw new SyncError(
        `加密后的存档约 ${(blob.size / 1024 / 1024).toFixed(2)}MB，超过 Gist 约 1MB 的限制。`
          + '请在同步设置中关闭部分同步内容，或改用 Supabase。'
      );
    }
    try {
      const encoded = await blobToBase64(blob);
      const gistId = await resolveGistId(settings, token);
      if (!gistId) {
        const created = await createGistWithFiles(token, GIST_DESCRIPTION, {
          [MANIFEST_FILE_NAME]: JSON.stringify(emptyManifest()),
          [PAYLOAD_FILE_NAME]: encoded,
        });
        saveSyncSettings({ gistId: created });
      } else {
        await updateGistFiles(token, gistId, { [PAYLOAD_FILE_NAME]: encoded });
      }
      return {
        id: `${info.syncedAt}-gist`,
        createdAt: Date.now(),
        syncedAt: info.syncedAt,
        deviceLabel: settings.deviceLabel,
        clientId: settings.clientId,
        sizeBytes: blob.size,
        encrypted: info.encrypted,
        objectName: PAYLOAD_FILE_NAME,
      } satisfies SyncVersionEntry;
    } catch (error) {
      wrapGistError(error, '上传到 Gist 失败');
    }
  },

  async downloadPayload(settings, objectName): Promise<RemoteObjectPayload> {
    applyProxy(settings);
    const token = requireToken(settings);
    try {
      const gistId = await resolveGistId(settings, token);
      if (!gistId) throw new SyncError('尚未创建同步 Gist，请先完成一次上传');
      const files = await getGistFileMap(token, gistId);
      const encoded = files[objectName] || files[PAYLOAD_FILE_NAME];
      if (!encoded) throw new SyncError('Gist 中没有可恢复的存档数据');
      const syncedAt = Number(objectName.split('#')[1]) || Date.now();
      return { blob: base64ToBlob(encoded), updatedAt: syncedAt };
    } catch (error) {
      wrapGistError(error, '从 Gist 下载失败');
    }
  },

  async deleteObjects() {
    // Gist 只保留一份最新存档，历史版本保留在清单里，无需远端清理。
  },
};
