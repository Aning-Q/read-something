import React, { useState, useEffect, useCallback } from 'react';
import { Cloud, CloudOff, RefreshCw, CheckCircle, AlertCircle, Loader2, Trash2, HelpCircle } from 'lucide-react';
import {
  getSyncSettings,
  saveSyncSettings,
  clearSyncSettings,
  performSync,
  validateAndConfigureGist,
} from '../../utils/gistSync/syncEngine';
import { GistSyncSettings } from '../../utils/gistSync/types';

interface GistSyncSettingsProps {
  isDarkMode: boolean;
  onSyncCompleted?: () => void;
}

const GistSyncSettings: React.FC<GistSyncSettingsProps> = ({ isDarkMode, onSyncCompleted }) => {
  const [settings, setSettings] = useState<GistSyncSettings | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [isTesting, setIsTesting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error' | ''; message: string }>({ type: '', message: '' });
  const [progressMessage, setProgressMessage] = useState('');
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    const saved = getSyncSettings();
    setSettings(saved);
    if (saved?.githubToken) {
      setTokenInput(saved.githubToken);
    }
  }, []);

  const clearStatus = useCallback(() => {
    setTimeout(() => setStatus({ type: '', message: '' }), 5000);
  }, []);

  const handleTestAndSave = async () => {
    // 先保存设置（包括代理配置）
    const partialSettings: Partial<GistSyncSettings> = {
      enabled: false,
      githubToken: tokenInput.trim(),
      gistId: '',
      ...settings,
    };
    saveSyncSettings(partialSettings);
    
    // 配置代理
    if (partialSettings.useProxy && partialSettings.proxyUrl) {
      (globalThis as any).__gist_proxy_url = partialSettings.proxyUrl?.trim();
    } else {
      delete (globalThis as any).__gist_proxy_url;
    }

    if (!tokenInput.trim()) {
      setStatus({ type: 'error', message: '请输入 GitHub Token' });
      clearStatus();
      return;
    }

    setIsTesting(true);
    setProgressMessage('正在验证 Token...');

    try {
      const { gistId, isNew } = await validateAndConfigureGist(tokenInput.trim());
      
      const newSettings: GistSyncSettings = {
        enabled: true,
        githubToken: tokenInput.trim(),
        gistId,
        autoSync: settings?.autoSync ?? true,
        syncImages: settings?.syncImages ?? false,
        lastSyncedAt: settings?.lastSyncedAt ?? 0,
      };

      saveSyncSettings(newSettings);
      setSettings(newSettings);
      setStatus({ type: 'success', message: isNew ? '已创建新的同步 Gist！' : '验证成功，已找到现有同步 Gist！' });
      clearStatus();
    } catch (error) {
      setStatus({ type: 'error', message: error instanceof Error ? error.message : '验证失败' });
      clearStatus();
    } finally {
      setIsTesting(false);
      setProgressMessage('');
    }
  };

  const handleSyncNow = async () => {
    if (!settings?.enabled) return;

    setIsSyncing(true);
    setProgressMessage('准备同步...');

    const result = await performSync('both', (msg) => {
      setProgressMessage(msg);
    });

    if (result.success) {
      let message = '同步完成！';
      if (result.pulled && result.pushed) {
        message = `拉取 ${result.pulled} 项，推送 ${result.pushed} 项`;
      } else if (result.pulled) {
        message = `已拉取 ${result.pulled} 项`;
      } else if (result.pushed) {
        message = `已推送 ${result.pushed} 项`;
      }
      setStatus({ type: 'success', message });
      onSyncCompleted?.();
    } else {
      setStatus({ type: 'error', message: result.error || '同步失败' });
    }

    clearStatus();
    setIsSyncing(false);
    setProgressMessage('');
    
    const latestSettings = getSyncSettings();
    setSettings(latestSettings);
  };

  const handleToggleAutoSync = (autoSync: boolean) => {
    if (!settings) return;
    const newSettings = { ...settings, autoSync };
    saveSyncSettings(newSettings);
    setSettings(newSettings);
  };

  const handleDisableSync = () => {
    if (confirm('确定要关闭 Gist 同步吗？配置将被清除。')) {
      clearSyncSettings();
      setSettings(null);
      setTokenInput('');
      setStatus({ type: 'success', message: '已关闭同步功能' });
      clearStatus();
    }
  };

  const inputBgClass = isDarkMode ? 'bg-zinc-800 border-zinc-700' : 'bg-white border-gray-300';
  const mutedTextClass = isDarkMode ? 'text-zinc-400' : 'text-gray-500';
  const cardBgClass = isDarkMode ? 'bg-zinc-800/50' : 'bg-gray-50';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {settings?.enabled ? (
            <Cloud className="w-5 h-5 text-green-500" />
          ) : (
            <CloudOff className="w-5 h-5 text-gray-400" />
          )}
          <h3 className="font-medium">跨设备同步 (GitHub Gist)</h3>
          <button
            onClick={() => setShowHelp(!showHelp)}
            className="p-1 rounded hover:bg-gray-200 dark:hover:bg-zinc-700 transition-colors"
          >
            <HelpCircle className={`w-4 h-4 ${mutedTextClass}`} />
          </button>
        </div>
        {settings?.enabled && (
          <span className={`text-xs px-2 py-1 rounded-full ${
            isDarkMode ? 'bg-green-900/50 text-green-400' : 'bg-green-100 text-green-700'
          }`}>
            已启用
          </span>
        )}
      </div>

      {showHelp && (
        <div className={`p-3 rounded-lg text-sm ${cardBgClass} ${mutedTextClass}`}>
          <p className="font-medium mb-2">使用说明：</p>
          <ol className="list-decimal list-inside space-y-1">
            <li>访问 <a href="https://github.com/settings/tokens/new?scopes=gist" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">GitHub Settings</a> 创建 Personal Access Token</li>
            <li>勾选 <code className="px-1 rounded bg-gray-200 dark:bg-zinc-700">gist</code> 权限</li>
            <li>将 Token 粘贴到下方输入框</li>
            <li>扩展会自动创建私有 Gist 用于存储同步数据</li>
          </ol>
        </div>
      )}

      {status.message && (
        <div className={`flex items-center gap-2 p-3 rounded-lg text-sm ${
          status.type === 'success'
            ? isDarkMode ? 'bg-green-900/30 text-green-400' : 'bg-green-100 text-green-700'
            : isDarkMode ? 'bg-red-900/30 text-red-400' : 'bg-red-100 text-red-700'
        }`}>
          {status.type === 'success' ? (
            <CheckCircle className="w-4 h-4" />
          ) : (
            <AlertCircle className="w-4 h-4" />
          )}
          {status.message}
        </div>
      )}

      {progressMessage && (
        <div className={`flex items-center gap-2 p-3 rounded-lg text-sm ${
          isDarkMode ? 'bg-blue-900/30 text-blue-400' : 'bg-blue-100 text-blue-700'
        }`}>
          <Loader2 className="w-4 h-4 animate-spin" />
          {progressMessage}
        </div>
      )}

      {!settings?.enabled ? (
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">
              GitHub Personal Access Token
            </label>
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="ghp_xxxxxxxxxxxxxxxx"
              className={`w-full px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${inputBgClass}`}
              disabled={isTesting}
            />
            <p className={`mt-1 text-xs ${mutedTextClass}`}>
              只需授予 gist 权限，Token 仅在本地存储
            </p>
          </div>
          
          {/* CORS 代理配置 */}
          <div>
            <label className="flex items-center justify-between mb-1">
              <span className="text-sm font-medium">使用代理（解决跨域问题）</span>
              <input
                type="checkbox"
                checked={settings?.useProxy ?? true}
                onChange={(e) => {
                  saveSyncSettings({ useProxy: e.target.checked });
                  setSettings(prev => prev ? { ...prev, useProxy: e.target.checked } : prev);
                }}
                className="w-4 h-4 accent-blue-500"
              />
            </label>
            {(settings?.useProxy ?? true) && (
              <input
                type="text"
                value={settings?.proxyUrl || ''}
                onChange={(e) => {
                  saveSyncSettings({ proxyUrl: e.target.value });
                  setSettings(prev => prev ? { ...prev, proxyUrl: e.target.value } : prev);
                }}
                placeholder="https://your-worker.your-name.workers.dev"
                className={`w-full px-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${inputBgClass}`}
              />
            )}
            <p className={`mt-1 text-xs ${mutedTextClass}`}>
              从 GitHub Pages 访问时必须配置代理
              {(settings?.useProxy ?? true) && !settings?.proxyUrl?.trim() && (
                <span className="text-orange-500 block">⚠️ 请先填写代理地址</span>
              )}
            </p>
          </div>
          
          {/* 测试连接按钮 */}
          {(settings?.useProxy ?? true) && settings?.proxyUrl?.trim() && (
            <button
              onClick={async () => {
                try {
                  const proxyUrl = settings.proxyUrl.trim().replace(/\/$/, '');
                  const res = await fetch(proxyUrl + '/health', {
                    signal: AbortSignal.timeout(10000),
                  });
                  if (res.ok) {
                    setStatus({ type: 'success', message: '✅ 代理连接正常！' });
                  } else {
                    setStatus({ type: 'error', message: `❌ 代理响应异常: ${res.status}` });
                  }
                } catch (e) {
                  setStatus({ type: 'error', message: `❌ 代理连接失败: ${e.message}` });
                }
              }}
              disabled={isTesting || isSyncing}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-sm font-medium hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors mb-2"
            >
              🔍 测试代理连接
            </button>
          )}
          
          <button
            onClick={handleTestAndSave}
            disabled={
  isTesting || 
  !tokenInput.trim() || 
  ((settings?.useProxy ?? true) && !settings?.proxyUrl?.trim())
}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isTesting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                验证中...
              </>
            ) : (
              <>
                <CheckCircle className="w-4 h-4" />
                验证并启用同步
              </>
            )}
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className={`p-3 rounded-lg ${cardBgClass}`}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">Gist ID</span>
              <span className="text-xs font-mono truncate max-w-[200px] opacity-70">
                {settings.gistId}
              </span>
            </div>
            {settings.lastSyncedAt > 0 && (
              <div className="flex items-center justify-between">
                <span className={`text-sm ${mutedTextClass}`}>上次同步</span>
                <span className="text-xs">
                  {new Date(settings.lastSyncedAt).toLocaleString('zh-CN')}
                </span>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-sm">自动同步</span>
              <input
                type="checkbox"
                checked={settings.autoSync}
                onChange={(e) => handleToggleAutoSync(e.target.checked)}
                className="w-4 h-4 accent-blue-500"
              />
            </label>
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleSyncNow}
              disabled={isSyncing}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isSyncing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
              立即同步
            </button>
            <button
              onClick={handleDisableSync}
              className="px-4 py-2 rounded-lg bg-red-500/10 text-red-500 text-sm font-medium hover:bg-red-500/20 transition-colors"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default GistSyncSettings;
