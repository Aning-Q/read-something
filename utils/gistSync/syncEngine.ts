import {
  GistSyncSettings,
  SyncSnapshot,
  SyncResult,
  SyncDirection,
  GIST_SETTINGS_KEY,
  GIST_FILENAME,
  CLIENT_ID_KEY,
  SYNC_LOCALSTORAGE_KEYS,
} from './types';

import {
  getAllBookContents,
  replaceAllBookContents,
} from '../bookContentStorage';
import {
  getStoredChatHistoryStore,
  replaceStoredChatHistoryStore,
} from '../chatHistoryStorage';
import {
  exportStudyHubForArchive,
  restoreStudyHubFromArchive,
} from '../studyHubStorage';
import {
  testToken,
  findSyncGist,
  createSyncGist,
  getGistContent,
  updateGistContent,
  GistApiError,
} from './gistApi';

const getClientId = (): string => {
  let clientId = localStorage.getItem(CLIENT_ID_KEY);
  if (!clientId) {
    clientId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(CLIENT_ID_KEY, clientId);
  }
  return clientId;
};

export const getSyncSettings = (): GistSyncSettings | null => {
  try {
    const raw = localStorage.getItem(GIST_SETTINGS_KEY);
    if (!raw) return null;
    const settings = JSON.parse(raw);
    
    // 向后兼容：Token 可能在旧版本中是明文存储的
    // 如果需要迁移，可以在这里处理
    return settings;
  } catch {
    return null;
  }
};

export const saveSyncSettings = (settings: Partial<GistSyncSettings>): void => {
  const existing = getSyncSettings() || {
    enabled: false,
    githubToken: '',
    gistId: '',
    autoSync: true,
    syncImages: false,
    lastSyncedAt: 0,
    useProxy: true,
    proxyUrl: '',
  };
  
  const merged: GistSyncSettings = { ...existing, ...settings };
  localStorage.setItem(GIST_SETTINGS_KEY, JSON.stringify(merged));
};

export const clearSyncSettings = (): void => {
  localStorage.removeItem(GIST_SETTINGS_KEY);
};

const buildLocalStorageSnapshot = (): Record<string, string> => {
  const snapshot: Record<string, string> = {};
  
  for (const key of SYNC_LOCALSTORAGE_KEYS) {
    const value = localStorage.getItem(key);
    if (value !== null) {
      snapshot[key] = value;
    }
  }
  
  return snapshot;
};

const restoreLocalStorageSnapshot = (snapshot: Record<string, string>): void => {
  for (const [key, value] of Object.entries(snapshot)) {
    if (SYNC_LOCALSTORAGE_KEYS.includes(key) && value !== undefined) {
      localStorage.setItem(key, value);
    }
  }
};

export const buildSyncSnapshot = async (): Promise<SyncSnapshot> => {
  const now = Date.now();
  
  // 并行获取所有数据
  const [bookContents, chatHistory, studyHubData] = await Promise.all([
    getAllBookContents(),
    getStoredChatHistoryStore(),
    exportStudyHubForArchive(),
  ]);
  
  const snapshot: SyncSnapshot = {
    schemaVersion: 2,
    clientId: getClientId(),
    syncedAt: now,
    localStorage: buildLocalStorageSnapshot(),
    bookContents,
    chatHistory,
    studyHub: studyHubData,
  };
  
  return snapshot;
};

export const restoreFromSnapshot = async (snapshot: SyncSnapshot): Promise<void> => {
  // 1. 恢复 localStorage
  restoreLocalStorageSnapshot(snapshot.localStorage);
  
  // 2. 恢复 IndexedDB 数据 (并行处理)
  await Promise.all([
    snapshot.bookContents ? replaceAllBookContents(snapshot.bookContents) : Promise.resolve(),
    snapshot.chatHistory ? replaceStoredChatHistoryStore(snapshot.chatHistory) : Promise.resolve(),
    snapshot.studyHub ? restoreStudyHubFromArchive(snapshot.studyHub) : Promise.resolve(),
  ]);
  
  // 通知 UI 刷新
  window.dispatchEvent(new CustomEvent('gist-sync-restored'));
};

const compareAndMergeSnapshots = (
  local: SyncSnapshot,
  remote: SyncSnapshot
): { shouldUpdateLocal: boolean; shouldUpdateRemote: boolean; conflicts: string[] } => {
  const shouldUpdateLocal = remote.syncedAt > local.syncedAt;
  const shouldUpdateRemote = remote.syncedAt < local.syncedAt;
  const conflicts: string[] = [];
  
  // 简单策略：以时间戳较新的为准
  // Phase 2 可以在这里实现更精细的合并逻辑
  
  return { shouldUpdateLocal, shouldUpdateRemote, conflicts };
};

export const validateAndConfigureGist = async (token: string): Promise<{ gistId: string; isNew: boolean }> => {
  await testToken(token);
  
  let gistId = await findSyncGist(token);
  const isNew = !gistId;
  
  if (!gistId) {
    const initialSnapshot: SyncSnapshot = {
      schemaVersion: 1,
      clientId: getClientId(),
      syncedAt: Date.now(),
      localStorage: buildLocalStorageSnapshot(),
      studyHub: { notebooks: [], quizSessions: [], favoriteQuotes: [] },
    };
    
    gistId = await createSyncGist(token, JSON.stringify(initialSnapshot, null, 2));
  }
  
  return { gistId, isNew };
};

export const performSync = async (
  direction: SyncDirection = 'both',
  onProgress?: (message: string) => void
): Promise<SyncResult> => {
  const settings = getSyncSettings();
  
  // 配置代理（全局方式）
  if (settings?.useProxy && settings?.proxyUrl) {
    (globalThis as any).__gist_proxy_url = settings.proxyUrl.trim();
  } else {
    delete (globalThis as any).__gist_proxy_url;
  }
  
  if (!settings || !settings.enabled) {
    return { success: false, error: '同步功能未启用' };
  }
  
  if (!settings.githubToken) {
    return { success: false, error: '未配置 GitHub Token' };
  }
  
  try {
    if (onProgress) onProgress('正在连接 GitHub...');
    
    if (!settings.gistId) {
      if (onProgress) onProgress('正在查找或创建同步 Gist...');
      const { gistId } = await validateAndConfigureGist(settings.githubToken);
      saveSyncSettings({ gistId });
      settings.gistId = gistId;
    }
    
    const localSnapshot = await buildSyncSnapshot();
    let remoteSnapshot: SyncSnapshot | null = null;
    let remoteUpdatedAt = 0;
    
    if (direction === 'pull' || direction === 'both') {
      if (onProgress) onProgress('正在拉取远程数据...');
      
      try {
        const { content, updatedAt } = await getGistContent(settings.githubToken, settings.gistId);
        remoteSnapshot = JSON.parse(content);
        remoteUpdatedAt = updatedAt;
      } catch (error) {
        if (error instanceof GistApiError && error.statusCode === 404) {
          if (onProgress) onProgress('Gist 不存在，正在重新创建...');
          const { gistId } = await validateAndConfigureGist(settings.githubToken);
          saveSyncSettings({ gistId });
          settings.gistId = gistId;
          remoteSnapshot = null;
        } else {
          throw error;
        }
      }
    }
    
    let pulled = 0;
    let pushed = 0;
    const conflicts: string[] = [];
    
    if (remoteSnapshot && (direction === 'pull' || direction === 'both')) {
      const { shouldUpdateLocal } = compareAndMergeSnapshots(localSnapshot, remoteSnapshot);
      
      if (shouldUpdateLocal) {
        if (onProgress) onProgress('正在合并远程数据...');
        await restoreFromSnapshot(remoteSnapshot);
        // 统计同步的项目数：配置 + 书籍 + 聊天
        pulled = Object.keys(remoteSnapshot.localStorage).length;
        pulled += Object.keys(remoteSnapshot.bookContents || {}).length;
        pulled += Object.keys(remoteSnapshot.chatHistory || {}).length;
      }
    }
    
    if (direction === 'push' || direction === 'both') {
      if (onProgress) onProgress('正在推送本地数据...');
      
      const newSnapshot = await buildSyncSnapshot();
      await updateGistContent(
        settings.githubToken,
        settings.gistId,
        JSON.stringify(newSnapshot, null, 2)
      );
      
      // 统计推送的项目数：配置 + 书籍 + 聊天
      pushed = Object.keys(newSnapshot.localStorage).length;
      pushed += Object.keys(newSnapshot.bookContents || {}).length;
      pushed += Object.keys(newSnapshot.chatHistory || {}).length;
      saveSyncSettings({ lastSyncedAt: Date.now() });
    }
    
    if (onProgress) onProgress('同步完成！');
    
    return {
      success: true,
      pulled,
      pushed,
      conflicts,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    return { success: false, error: message };
  }
};

let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;

export const scheduleSync = (delayMs: number = 3000): void => {
  const settings = getSyncSettings();
  if (!settings?.enabled || !settings?.autoSync) {
    return;
  }
  
  if (syncDebounceTimer) {
    clearTimeout(syncDebounceTimer);
  }
  
  syncDebounceTimer = setTimeout(() => {
    performSync('push').catch(() => {
      // 静默失败，不影响用户
    });
    syncDebounceTimer = null;
  }, delayMs);
};

export const cancelScheduledSync = (): void => {
  if (syncDebounceTimer) {
    clearTimeout(syncDebounceTimer);
    syncDebounceTimer = null;
  }
};
