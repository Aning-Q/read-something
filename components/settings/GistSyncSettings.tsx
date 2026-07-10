import React from 'react';
import { CloudOff, AlertTriangle } from 'lucide-react';

interface GistSyncSettingsProps {
  isDarkMode: boolean;
  onSyncCompleted?: () => void;
}

const GistSyncSettings: React.FC<GistSyncSettingsProps> = ({ isDarkMode }) => {
  const cardBgClass = isDarkMode ? 'bg-zinc-800/50' : 'bg-gray-50';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <CloudOff className="w-5 h-5 text-gray-400" />
        <h3 className="font-medium">跨设备同步 (GitHub Gist)</h3>
      </div>

      {/* 提示框 */}
      <div className="p-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-amber-800 dark:text-amber-300 mb-1">
              暂不开放
            </p>
            <p className="text-sm text-amber-700 dark:text-amber-400">
              同步功能设计框架有问题，正在重新设计中，暂时无法使用。
            </p>
            <p className="text-xs text-amber-600 dark:text-amber-500 mt-2">
              请等待后续版本更新，感谢您的理解！
            </p>
          </div>
        </div>
      </div>

      {/* 禁用的设置区域 */}
      <div className={`p-4 rounded-lg ${cardBgClass} opacity-50 pointer-events-none`}>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">
              🔐 GitHub Personal Access Token
            </label>
            <input
              type="password"
              disabled
              placeholder="ghp_xxxxxxxxxx"
              className="w-full px-3 py-2 rounded-lg border text-sm bg-gray-100 dark:bg-gray-700 cursor-not-allowed"
            />
            <p className="text-xs mt-1 text-gray-500">
              只需授予 gist 权限，Token 仅在本地存储
            </p>
          </div>

          <button
            disabled
            className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-gray-400 text-white text-sm font-medium cursor-not-allowed"
          >
            验证并启用同步
          </button>
        </div>
      </div>
    </div>
  );
};

export default GistSyncSettings;
