import { buildSyncPayload, restoreSyncPayloadBlob } from './archiveAdapter';
import { decryptBlob, encryptBlob } from './crypto';
import { gistProvider } from './gistProvider';
import { SyncProvider } from './provider';
import { supabaseProvider } from './supabaseProvider';
import {
  getSyncSettings,
  getSyncState,
  saveSyncSettings,
  saveSyncState,
} from './syncSettings';
import {
  SyncConnectionSettings,
  SyncDirection,
  SyncError,
  SyncManifest,
  SyncProviderId,
  SyncResult,
  SyncVersionEntry,
  SYNC_APP_ID,
  SYNC_MANIFEST_SCHEMA,
  SYNC_MANIFEST_SCHEMA_VERSION,
} from './types';

const PROVIDERS: Record<SyncProviderId, SyncProvider> = {
  gist: gistProvider,
  supabase: supabaseProvider,
};

let syncInProgress = false;

export const getProvider = (providerId: SyncProviderId): SyncProvider => PROVIDERS[providerId];

export const listProviders = (): Array<{ id: SyncProviderId; label: string }> =>
  (Object.keys(PROVIDERS) as SyncProviderId[]).map((id) => ({ id, label: PROVIDERS[id].label }));

/** 同步引擎负责编排：打包 → 加密 → 上传 / 下载 → 解密 → 还原。 */

const emptyManifest = (): SyncManifest => ({
  schema: SYNC_MANIFEST_SCHEMA,
  schemaVersion: SYNC_MANIFEST_SCHEMA_VERSION,
  appId: SYNC_APP_ID,
  updatedAt: 0,
  latestVersionId: null,
  latestObjectName: '',
  versions: [],
});

const sortVersions = (versions: SyncVersionEntry[]): SyncVersionEntry[] =>
  [...versions].sort((left, right) => right.syncedAt - left.syncedAt);

/**
 * 比较基准必须绑定到具体后端和账号。切换 Supabase 项目、邮箱或 Gist 后，
 * 旧目标的 version id 没有任何意义，不能拿来判断新目标是否发生变化。
 */
const getTargetKey = (settings: SyncConnectionSettings): string => {
  if (settings.provider === 'supabase') {
    const url = (settings.supabaseUrl || '').trim().replace(/\/+$/, '').toLowerCase();
    // email 在首次登录前后都稳定；user id 只会在登录成功后才出现，不能用于首次比较基准。
    const account = (settings.supabaseEmail || '').trim().toLowerCase();
    return `supabase:${url}:${settings.supabaseBucket || ''}:${account}`;
  }
  // 自动创建 Gist 前还没有 gistId；用 token 尾部作本机目标标识，避免首次上传后目标键突变。
  const tokenHint = (settings.githubToken || '').trim().slice(-12);
  return `gist:${tokenHint || 'missing'}`;
};

const conflictResult = (message: string): SyncResult => ({
  success: false,
  error: message,
  warnings: [{ type: 'conflict', message }],
});

const describeResult = (pulled: number, pushed: number): string => {
  if (pulled > 0 && pushed > 0) return '已合并云端与本机数据';
  if (pulled > 0) return '已从云端恢复';
  if (pushed > 0) return '已上传到云端';
  return '云端与本机已是最新';
};

/** 稍作延迟再请求刷新，让界面有机会把同步结果展示出来。 */
const notifyStateReload = (): void => {
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent('app-state-reload-requested'));
  }, 800);
};

/**
 * 判断是否需要拉取云端数据。
 * 只有「云端更新、且不是本机推上去的」才覆盖本机，避免把本机较新的改动冲掉。
 */
const shouldPullRemote = (
  manifest: SyncManifest,
  settings: SyncConnectionSettings,
  localSyncedAt: number
): boolean => {
  const latest = sortVersions(manifest.versions)[0];
  if (!latest) return false;
  if (latest.clientId && latest.clientId === settings.clientId) return false;
  const remoteTime = latest.syncedAt || manifest.updatedAt;
  return remoteTime > localSyncedAt;
};

const pruneOldVersions = async (
  provider: SyncProvider,
  settings: SyncConnectionSettings,
  manifest: SyncManifest
): Promise<SyncManifest> => {
  const sorted = sortVersions(manifest.versions);
  const keep = Math.max(1, Math.min(50, settings.keepVersions || 5));
  if (sorted.length <= keep) return manifest;

  const dropped = sorted.slice(keep);
  try {
    await provider.deleteObjects(settings, dropped.map((entry) => entry.objectName));
  } catch {
    // 清理历史版本失败不应让同步整体失败
    return manifest;
  }
  return { ...manifest, versions: sortVersions(manifest.versions).slice(0, keep) };
};

const pushPayload = async (
  provider: SyncProvider,
  settings: SyncConnectionSettings,
  manifest: SyncManifest,
  onProgress?: (message: string) => void
): Promise<{ manifest: SyncManifest; sizeBytes: number; syncedAt: number }> => {
  onProgress?.('正在整理本机数据...');
  const bundle = await buildSyncPayload(settings);

  if (bundle.sizeBytes === 0) {
    throw new SyncError('没有可同步的数据');
  }

  onProgress?.('正在加密存档...');
  const encrypted = await encryptBlob(bundle.blob, settings.syncPassword);

  onProgress?.('正在上传到云端...');
  const version = await provider.uploadPayload(settings, encrypted, {
    syncedAt: bundle.meta.syncedAt,
    encrypted: true,
  });

  let nextManifest: SyncManifest = {
    ...emptyManifest(),
    ...manifest,
    updatedAt: version.syncedAt,
    latestVersionId: version.id,
    latestObjectName: version.objectName,
    versions: sortVersions([version, ...manifest.versions]).slice(0, 60),
  };

  nextManifest = await pruneOldVersions(provider, settings, nextManifest);
  onProgress?.('正在更新云端清单...');
  await provider.writeManifest(settings, nextManifest);

  return { manifest: nextManifest, sizeBytes: bundle.sizeBytes, syncedAt: version.syncedAt };
};

const pullPayload = async (
  provider: SyncProvider,
  settings: SyncConnectionSettings,
  manifest: SyncManifest,
  onProgress?: (message: string) => void
): Promise<{ restored: boolean; syncedAt: number }> => {
  const latest = sortVersions(manifest.versions)[0];
  const objectName = latest?.objectName || manifest.latestObjectName;
  if (!objectName) return { restored: false, syncedAt: 0 };

  onProgress?.('正在下载云端存档...');
  const remote = await provider.downloadPayload(settings, objectName);

  onProgress?.('正在解密存档...');
  const decrypted = await decryptBlob(remote.blob, settings.syncPassword);

  onProgress?.('正在恢复到本机...');
  await restoreSyncPayloadBlob(decrypted);

  return { restored: true, syncedAt: latest?.syncedAt || remote.updatedAt };
};

export const performSync = async (
  direction: SyncDirection = 'both',
  onProgress?: (message: string) => void,
  settingsOverride?: SyncConnectionSettings
): Promise<SyncResult> => {
  const settings = settingsOverride ?? getSyncSettings();
  const provider = getProvider(settings.provider);

  const configError = provider.validateSettings(settings);
  if (configError) {
    saveSyncState({ lastError: configError });
    return { success: false, error: configError };
  }
  if (!settings.enabled) {
    return { success: false, error: '同步功能尚未启用' };
  }
  if (syncInProgress) {
    return { success: false, error: '已有同步任务正在进行，请稍后再试' };
  }
  syncInProgress = true;

  const state = getSyncState();
  const targetKey = getTargetKey(settings);
  const sameTarget = state.targetKey === targetKey;
  const baselineVersionId = sameTarget ? state.lastVersionId : '';
  const localDirty = sameTarget ? state.localDirty : true;
  const warnings: SyncResult['warnings'] = [];

  try {
    onProgress?.('正在连接云端...');
    const manifest = await provider.readManifest(settings);

    let pulled = 0;
    let pushed = 0;
    let remoteSyncedAt = state.lastRemoteSyncedAt;
    let versionId: string | undefined;
    let latestManifest = manifest;
    const latestRemote = sortVersions(manifest.versions)[0];
    const remoteHasData = Boolean(latestRemote || manifest.latestObjectName);
    const remoteVersionId = latestRemote?.id || manifest.latestVersionId || '';
    const remoteChanged = remoteHasData && remoteVersionId !== baselineVersionId;

    // auto 只做「按需下载」，pull 是用户显式要求覆盖本机。
    const forcePull = direction === 'pull';
    const wantsPull = direction === 'pull' || direction === 'both' || direction === 'auto';
    const needsPull = wantsPull && (
      forcePull
      || (remoteChanged && !localDirty)
      || (!baselineVersionId && shouldPullRemote(manifest, settings, state.lastSyncedAt))
    );

    // 首次同步时云端可能已经有别的设备的存档，直接覆盖或上传都可能丢数据。
    // 这种情况下要求用户明确选择方向，而不是替他做决定。
    const isFirstSync = !sameTarget || !baselineVersionId;
    const remoteHasOtherDeviceData = Boolean(
      sortVersions(manifest.versions)[0]
        && sortVersions(manifest.versions)[0].clientId !== settings.clientId
    );
    const needsExplicitChoice = isFirstSync
      && (direction === 'both' || direction === 'auto' || direction === 'auto-push')
      && remoteHasOtherDeviceData;

    if (needsExplicitChoice) {
      const message =
        '云端已有其他设备的存档。为避免覆盖本机或云端数据，'
        + '请先选择「从云端恢复」或「立即上传」。';
      saveSyncState({ lastError: message });
      return {
        success: false,
        error: message,
        warnings: [{ type: 'conflict', message }],
      };
    }

    // 两端都从同一个同步基准继续修改时，不能用时间戳猜测谁应该获胜。
    // 自动上传与智能同步均停止；用户仍可用「立即上传」或「从云端恢复」明确选择。
    if (
      remoteChanged
      && localDirty
      && (direction === 'both' || direction === 'auto' || direction === 'auto-push')
    ) {
      const message =
        '检测到本机和云端在上次同步后都发生了修改。已停止自动覆盖，'
        + '请检查数据后选择「立即上传」或「从云端恢复」。';
      saveSyncState({ lastError: message });
      return conflictResult(message);
    }

    // 后台自动上传必须建立在当前云端版本仍等于本机同步基准的前提上。
    if (direction === 'auto-push' && remoteChanged) {
      const message = '云端已有其他设备的新版本，已暂停自动上传，请打开同步设置处理冲突。';
      saveSyncState({ lastError: message });
      return conflictResult(message);
    }

    if (needsPull) {
      const outcome = await pullPayload(provider, settings, manifest, onProgress);
      if (outcome.restored) {
        pulled = 1;
        remoteSyncedAt = outcome.syncedAt;
        onProgress?.('云端数据已恢复到本机');
        notifyStateReload();
      }
    }

    const wantsPush = direction === 'push'
      || direction === 'auto-push'
      || (direction === 'both' && (localDirty || !remoteHasData));
    if (wantsPush && !(direction === 'both' && needsPull && pulled > 0)) {
      const outcome = await pushPayload(provider, settings, latestManifest, onProgress);
      pushed = 1;
      latestManifest = outcome.manifest;
      versionId = outcome.manifest.latestVersionId ?? undefined;
      remoteSyncedAt = outcome.syncedAt;
    }

    if (latestManifest.versions.some((entry) => entry.encrypted === false)) {
      warnings.push({
        type: 'encryption',
        message: '云端存在未加密的历史存档，建议清理旧版本',
      });
    }

    const syncedAt = Date.now();
    saveSyncSettings({ lastSyncedAt: syncedAt });
    saveSyncState({
      lastSyncedAt: syncedAt,
      lastRemoteSyncedAt: remoteSyncedAt,
      lastVersionId: versionId || (pulled > 0 ? remoteVersionId : baselineVersionId),
      localDirty: pulled > 0 || pushed > 0 ? false : localDirty,
      targetKey,
      lastError: '',
      lastResult: describeResult(pulled, pushed),
    });

    onProgress?.('同步完成');
    return {
      success: true,
      pulled,
      pushed,
      warnings: warnings.length > 0 ? warnings : undefined,
      remoteSyncedAt,
      versionId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    saveSyncState({ lastError: message });
    return { success: false, error: message };
  } finally {
    syncInProgress = false;
  }
};

/** 仅测试连接，不读写任何存档。 */
export const testSyncConnection = async (
  settings: SyncConnectionSettings
): Promise<{ success: boolean; error?: string }> => {
  const provider = getProvider(settings.provider);
  const configError = provider.validateSettings(settings);
  if (configError) return { success: false, error: configError };
  try {
    await provider.testConnection(settings);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '连接失败' };
  }
};

export interface RemoteVersionSummary {
  id: string;
  syncedAt: number;
  deviceLabel: string;
  sizeBytes: number;
  encrypted: boolean;
  isLocalDevice: boolean;
}

export const fetchRemoteVersions = async (
  settings?: SyncConnectionSettings
): Promise<{ success: boolean; versions?: RemoteVersionSummary[]; error?: string }> => {
  const config = settings ?? getSyncSettings();
  const provider = getProvider(config.provider);
  try {
    const manifest = await provider.readManifest(config);
    return {
      success: true,
      versions: sortVersions(manifest.versions).map((entry) => ({
        id: entry.id,
        syncedAt: entry.syncedAt,
        deviceLabel: entry.deviceLabel,
        sizeBytes: entry.sizeBytes,
        encrypted: entry.encrypted,
        isLocalDevice: entry.clientId === config.clientId,
      })),
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : '读取云端版本失败' };
  }
};

let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;

export const scheduleSync = (delayMs: number = 3000): void => {
  // 即便同步暂时关闭，也要记住本机已经变化；重新启用时才能正确发现双端冲突。
  saveSyncState({ localDirty: true });
  const settings = getSyncSettings();
  if (!settings.enabled || !settings.autoSync) return;

  if (syncDebounceTimer) {
    clearTimeout(syncDebounceTimer);
  }
  syncDebounceTimer = setTimeout(() => {
    performSync('auto-push').catch(() => {});
    syncDebounceTimer = null;
  }, delayMs);
};

export const cancelScheduledSync = (): void => {
  if (syncDebounceTimer) {
    clearTimeout(syncDebounceTimer);
    syncDebounceTimer = null;
  }
};

export { getSyncSettings, saveSyncSettings, getSyncState, saveSyncState };
