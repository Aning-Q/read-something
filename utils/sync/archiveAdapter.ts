import {
  AppArchivePayload,
  createAppArchivePayload,
  parseAppArchiveFile,
  restoreAppArchivePayload,
  serializeAppArchive,
} from '../appArchive';
import {
  SyncConnectionSettings,
  SyncError,
  SyncPayloadMeta,
  SYNC_APP_ID,
  SYNC_OWNED_LOCAL_STORAGE_KEYS,
  SYNC_PAYLOAD_SCHEMA,
  SYNC_PAYLOAD_SCHEMA_VERSION,
} from './types';
import { withSyncDirtyTrackingSuspended } from './syncSettings';

export interface SyncPayloadBundle {
  blob: Blob;
  meta: SyncPayloadMeta;
  sizeBytes: number;
}

/** 打包本地应用数据为一份同步载荷，按设置裁剪体积较大的可选内容。 */
export const buildSyncPayload = async (
  settings: SyncConnectionSettings
): Promise<SyncPayloadBundle> => {
  const payload = await createAppArchivePayload({
    excludeLocalStorageKeys: SYNC_OWNED_LOCAL_STORAGE_KEYS,
    includeBookContents: settings.includeBookContents,
    includeImages: settings.includeImages,
    includeTtsAudio: settings.includeTtsAudio,
  });
  const serialized = await serializeAppArchive(payload);

  const meta: SyncPayloadMeta = {
    schema: SYNC_PAYLOAD_SCHEMA,
    schemaVersion: SYNC_PAYLOAD_SCHEMA_VERSION,
    appId: SYNC_APP_ID,
    clientId: settings.clientId,
    deviceLabel: settings.deviceLabel,
    syncedAt: Date.now(),
    encrypted: false,
    includeBookContents: settings.includeBookContents,
    includeImages: settings.includeImages,
    includeTtsAudio: settings.includeTtsAudio,
  };

  return { blob: serialized.blob, meta, sizeBytes: serialized.blob.size };
};

/**
 * 还原同步载荷。存档内部自带 schema 校验，这里复用 appArchive 的归一化流程，
 * 避免维护两份彼此漂移的校验规则。
 */
export const restoreSyncPayloadBlob = async (blob: Blob): Promise<AppArchivePayload> => {
  const file = new File([blob], 'sync-payload', { type: blob.type || 'application/octet-stream' });
  let raw: unknown;
  try {
    raw = await parseAppArchiveFile(file);
  } catch (error) {
    throw new SyncError(
      error instanceof Error ? `云端存档无法解析：${error.message}` : '云端存档无法解析'
    );
  }
  return withSyncDirtyTrackingSuspended(() =>
    restoreAppArchivePayload(raw, {
      // 恢复数据时保留本机的同步配置与登录状态，否则每次拉取都要重新登录。
      preserveLocalStorageKeys: SYNC_OWNED_LOCAL_STORAGE_KEYS,
    })
  );
};
