import {
  SyncSnapshot,
  SyncResult,
  SyncDirection,
  GIST_SETTINGS_KEY,
  CLIENT_ID_KEY,
} from './types';
import {
  GistApiError,
  testToken,
  findSyncGist,
  createSyncGist,
  getGistContent,
  updateGistContent,
} from './gistApi';
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

// 使用全局方式，避免打包时 tree-shaking 丢失
declare global {
  var __gist_proxy_url: string | undefined;
}

const getClientId = (): string => {
  let clientId = localStorage.getItem(CLIENT_ID_KEY);
  if (!clientId) {
    clientId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(CLIENT_ID_KEY, clientId);
  }
  return clientId;
};

export const getSyncSettings = (): any | null => {
  try {
    const raw = localStorage.getItem(GIST_SETTINGS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export const saveSyncSettings = (settings: Partial<any>): void => {
  const existing = getSyncSettings() || {
    enabled: false,
    githubToken: '',
    gistId: '',
    autoSync: true,
    syncImages: false,
    lastSyncedAt: 0,
    useProxy: true,
    proxyUrl: '',
    lightSyncMode: true,
  };
  
  const merged = { ...existing, ...settings };
  localStorage.setItem(GIST_SETTINGS_KEY, JSON.stringify(merged));
};

export const clearSyncSettings = (): void => {
  localStorage.removeItem(GIST_SETTINGS_KEY);
};

const buildLocalStorageSnapshot = (): Record<string, string> => {
  const snapshot: Record<string, string> = {};
  const keys = Object.keys(localStorage);
  for (const key of keys) {
    if (!key.startsWith('app_')) continue;
    if (key === GIST_SETTINGS_KEY) continue;
    const value = localStorage.getItem(key);
    if (value !== null) {
      snapshot[key] = value;
    }
  }
  return snapshot;
};

const restoreLocalStorageSnapshot = (snapshot: Record<string, string>): void => {
  for (const [key, value] of Object.entries(snapshot)) {
    if (key === GIST_SETTINGS_KEY) continue;
    if (value !== undefined) {
      localStorage.setItem(key, value);
    }
  }
};

export const buildSyncSnapshot = async (lightMode: boolean = true): Promise<SyncSnapshot> => {
  const now = Date.now();
  
  // 轻量模式：只同步 localStorage（设置、人设、书籍列表）
  if (lightMode) {
    return {
      schemaVersion: 2,
      clientId: getClientId(),
      syncedAt: now,
      localStorage: buildLocalStorageSnapshot(),
      bookContents: {},
      chatHistory: {},
      studyHub: { notebooks: [], quizSessions: [], favoriteQuotes: [] },
    } as unknown as SyncSnapshot;
  }
  
  // 完整模式：同步所有数据
  const [bookContents, chatHistory, studyHubData] = await Promise.all([
    getAllBookContents(),
    getStoredChatHistoryStore(),
    exportStudyHubForArchive(),
  ]);
  
  return {
    schemaVersion: 2,
    clientId: getClientId(),
    syncedAt: now,
    localStorage: buildLocalStorageSnapshot(),
    bookContents,
    chatHistory,
    studyHub: studyHubData,
  } as unknown as SyncSnapshot;
};

export const restoreFromSnapshot = async (snapshot: SyncSnapshot, lightMode: boolean = true): Promise<void> => {
  // 1. 恢复 localStorage
  restoreLocalStorageSnapshot(snapshot.localStorage);
  
  // 2. 完整模式才恢复 IndexedDB 数据
  if (!lightMode) {
    await Promise.all([
      snapshot.bookContents ? replaceAllBookContents(snapshot.bookContents) : Promise.resolve(),
      snapshot.chatHistory ? replaceStoredChatHistoryStore(snapshot.chatHistory) : Promise.resolve(),
      snapshot.studyHub ? restoreStudyHubFromArchive(snapshot.studyHub) : Promise.resolve(),
    ]);
  }
};

const compareAndMergeSnapshots = (local: SyncSnapshot, remote: SyncSnapshot): { shouldUpdateLocal: boolean } => {
  // 简单比较时间戳，远程较新就更新本地
  const shouldUpdateLocal = remote.syncedAt > local.syncedAt;
  return { shouldUpdateLocal };
};

export const validateAndConfigureGist = async (token: string): Promise<{ gistId: string; isNew: boolean }> => {
  await testToken(token);
  
  let gistId = await findSyncGist(token);
  const isNew = !gistId;
  
  if (!gistId) {
    // 初始同步使用轻量模式
    const initialSnapshot = await buildSyncSnapshot(true);
    gistId = await createSyncGist(token, JSON.stringify(initialSnapshot, null, 2));
  }
  
  return { gistId, isNew };
};

export const performSync = async (
  direction: SyncDirection = 'both',
  onProgress?: (message: string) => void
): Promise<SyncResult> => {
  const settings = getSyncSettings();
  
  if (!settings || !settings.enabled) {
    return { success: false, error: '同步功能未启用' };
  }
  
  if (!settings.githubToken) {
    return { success: false, error: '未配置 GitHub Token' };
  }
  
  // 配置代理
  if (settings.useProxy && settings.proxyUrl) {
    (globalThis as any).__gist_proxy_url = settings.proxyUrl.trim();
  } else {
    delete (globalThis as any).__gist_proxy_url;
  }
  
  const lightMode = settings.lightSyncMode ?? true;
  
  try {
    if (onProgress) onProgress('正在连接 GitHub...');
    
    if (!settings.gistId) {
      if (onProgress) onProgress('正在查找或创建同步 Gist...');
      const { gistId } = await validateAndConfigureGist(settings.githubToken);
      saveSyncSettings({ gistId });
      settings.gistId = gistId;
    }
    
    const localSnapshot = await buildSyncSnapshot(lightMode);
    let remoteSnapshot: SyncSnapshot | null = null;
    
    if (direction === 'pull' || direction === 'both') {
      if (onProgress) onProgress('正在拉取远程数据...');
      
      try {
        const { content } = await getGistContent(settings.githubToken, settings.gistId);
        remoteSnapshot = JSON.parse(content);
      } catch (error) {
        if (error instanceof GistApiError && error.message.includes('404')) {
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
    
    if (remoteSnapshot && (direction === 'pull' || direction === 'both')) {
      const { shouldUpdateLocal } = compareAndMergeSnapshots(localSnapshot, remoteSnapshot);
      
      if (shouldUpdateLocal) {
        if (onProgress) onProgress('正在合并远程数据...');
        await restoreFromSnapshot(remoteSnapshot, lightMode);
        pulled = Object.keys(remoteSnapshot.localStorage).length;
        if (!lightMode) {
          pulled += Object.keys(remoteSnapshot.bookContents || {}).length;
          pulled += Object.keys(remoteSnapshot.chatHistory || {}).length;
        }
      }
    }
    
    if (direction === 'push' || direction === 'both') {
      if (onProgress) onProgress('正在推送本地数据...');
      
      const newSnapshot = await buildSyncSnapshot(lightMode);
      await updateGistContent(
        settings.githubToken,
        settings.gistId,
        JSON.stringify(newSnapshot, null, 2)
      );
      
      pushed = Object.keys(newSnapshot.localStorage).length;
      if (!lightMode) {
        pushed += Object.keys(newSnapshot.bookContents || {}).length;
        pushed += Object.keys(newSnapshot.chatHistory || {}).length;
      }
      saveSyncSettings({ lastSyncedAt: Date.now() });
    }
    
    if (onProgress) onProgress('同步完成！');
    
    return {
      success: true,
      pulled,
      pushed,
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
    performSync('push').catch(() => {});
    syncDebounceTimer = null;
  }, delayMs);
};

export const cancelScheduledSync = (): void => {
  if (syncDebounceTimer) {
    clearTimeout(syncDebounceTimer);
    syncDebounceTimer = null;
  }
};
