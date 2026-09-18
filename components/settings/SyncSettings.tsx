import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Database,
  Github,
  Loader2,
  Lock,
  RefreshCw,
  Upload,
  Download,
  ShieldCheck,
} from 'lucide-react';
import {
  RemoteVersionSummary,
  fetchRemoteVersions,
  getProvider,
  listProviders,
  performSync,
  testSyncConnection,
} from '../../utils/sync/syncEngine';
import {
  formatSyncTime,
  getSyncSettings,
  getSyncState,
  saveSyncSettings,
} from '../../utils/sync/syncSettings';
import {
  DEFAULT_SUPABASE_BUCKET,
  SyncConnectionSettings,
  SyncProviderId,
} from '../../utils/sync/types';
import { formatBytes } from '../../utils/appArchive';

interface SyncSettingsProps {
  isDarkMode: boolean;
  onSyncCompleted?: () => void;
}

type BusyState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'sync'; direction: 'pull' | 'push' | 'both' }
  | { kind: 'versions' };

const PROVIDER_ICONS: Record<SyncProviderId, React.ComponentType<{ className?: string; size?: number }>> = {
  supabase: Database,
  gist: Github,
};

const PROVIDER_SUMMARY: Record<SyncProviderId, string> = {
  supabase: '数据库 + 对象存储，容量大，适合保存完整存档',
  gist: '无需自建服务，但单文件约 1MB，适合轻量同步',
};

const SyncSettings: React.FC<SyncSettingsProps> = ({ isDarkMode, onSyncCompleted }) => {
  const [settings, setSettings] = useState<SyncConnectionSettings>(() => getSyncSettings());
  // 登录密码只保留在内存里，用于换取会话，不会写入本地存储。
  const [passwordDraft, setPasswordDraft] = useState('');
  const [state, setState] = useState(() => getSyncState());
  const [busy, setBusy] = useState<BusyState>({ kind: 'idle' });
  const [message, setMessage] = useState<{ type: 'ok' | 'error' | 'info'; text: string } | null>(
    state.lastError ? { type: 'error', text: state.lastError } : null
  );
  const [versions, setVersions] = useState<RemoteVersionSummary[] | null>(null);

  const inputClass = `w-full px-3 py-2 rounded-lg border text-sm ${isDarkMode ? 'bg-zinc-900 border-zinc-700 text-zinc-100' : 'bg-white border-gray-200 text-gray-800'}`;
  const cardClass = `p-4 rounded-xl ${isDarkMode ? 'bg-zinc-800/50' : 'bg-gray-50'}`;
  const labelClass = 'block text-sm font-medium mb-2';
  const hintClass = 'text-xs mt-1 text-gray-500 dark:text-gray-400';

  const provider = useMemo(() => getProvider(settings.provider), [settings.provider]);
  const effectiveSettings = useMemo<SyncConnectionSettings>(
    () => ({ ...settings, supabasePassword: passwordDraft }),
    [settings, passwordDraft]
  );
  const configError = useMemo(
    () => provider.validateSettings(effectiveSettings),
    [provider, effectiveSettings]
  );
  const syncDisabled = !!configError || !settings.enabled || busy.kind !== 'idle';

  useEffect(() => {
    setState(getSyncState());
  }, []);

  const update = useCallback((patch: Partial<SyncConnectionSettings>) => {
    setSettings(saveSyncSettings(patch));
  }, []);

  const handleTest = async () => {
    setBusy({ kind: 'testing' });
    setMessage(null);
    const result = await testSyncConnection(effectiveSettings);
    setBusy({ kind: 'idle' });
    setMessage(
      result.success
        ? { type: 'ok', text: `已连接 ${provider.label}，可以开始同步` }
        : { type: 'error', text: result.error || '连接失败' }
    );
  };

  const handleSync = async (direction: 'pull' | 'push' | 'both') => {
    if (direction === 'pull' && !window.confirm('从云端恢复会覆盖本机已同步范围内的数据，确定继续吗？')) {
      return;
    }
    if (direction === 'push' && !window.confirm('立即上传会把本机存档设为云端最新版本，确定继续吗？')) {
      return;
    }
    setBusy({ kind: 'sync', direction });
    setMessage({ type: 'info', text: '正在同步...' });
    const result = await performSync(direction, (text) => setMessage({ type: 'info', text }), effectiveSettings);
    setBusy({ kind: 'idle' });
    setState(getSyncState());

    if (!result.success) {
      setMessage({ type: 'error', text: result.error || '同步失败' });
      return;
    }
    setMessage({
      type: 'ok',
      text: direction === 'pull' ? '已从云端恢复到本机' : '同步完成，云端与本机一致',
    });
    if (direction !== 'push') {
      onSyncCompleted?.();
    }
  };

  const handleLoadVersions = async () => {
    setBusy({ kind: 'versions' });
    const result = await fetchRemoteVersions(effectiveSettings);
    setBusy({ kind: 'idle' });
    if (!result.success) {
      setMessage({ type: 'error', text: result.error || '读取云端版本失败' });
      return;
    }
    setVersions(result.versions || []);
  };

  const renderToggle = (active: boolean, onToggle: () => void, disabled = false) => (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={`w-12 h-7 rounded-full p-1 flex items-center transition-all ${
        disabled ? 'opacity-50 cursor-not-allowed' : ''
      } ${isDarkMode ? 'bg-zinc-700' : 'bg-gray-200'}`}
    >
      <div
        className={`w-5 h-5 rounded-full shadow-sm transition-transform duration-300 ${
          active ? 'translate-x-5 bg-rose-400' : 'translate-x-0 bg-slate-400'
        }`}
      />
    </button>
  );

  const renderRow = (
    title: string,
    description: string,
    active: boolean,
    onToggle: () => void,
    disabled = false
  ) => (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <div className={hintClass}>{description}</div>
      </div>
      {renderToggle(active, onToggle, disabled)}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Cloud className="w-5 h-5 text-blue-400" />
        <h3 className="font-medium">跨设备同步</h3>
      </div>

      {/* 状态条 */}
      <div className={cardClass}>
        <div className="flex items-center justify-between text-sm">
          <span className="text-gray-500 dark:text-gray-400">本机上次同步</span>
          <span className="font-medium">{formatSyncTime(state.lastSyncedAt)}</span>
        </div>
        <div className="flex items-center justify-between text-sm mt-2">
          <span className="text-gray-500 dark:text-gray-400">云端上次更新</span>
          <span className="font-medium">{formatSyncTime(state.lastRemoteSyncedAt)}</span>
        </div>
        <div className="flex items-center justify-between text-sm mt-2">
          <span className="text-gray-500 dark:text-gray-400">本机设备标识</span>
          <span className="font-medium truncate max-w-[60%] text-right">{settings.deviceLabel}</span>
        </div>
      </div>

      {message && (
        <div
          className={`p-3 rounded-lg text-sm flex items-start gap-2 ${
            message.type === 'ok'
              ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300'
              : message.type === 'error'
                ? 'bg-rose-50 dark:bg-rose-900/20 text-rose-700 dark:text-rose-300'
                : 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
          }`}
        >
          {message.type === 'ok' ? (
            <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
          ) : message.type === 'error' ? (
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          ) : (
            <Loader2 className="w-4 h-4 mt-0.5 flex-shrink-0 animate-spin" />
          )}
          <span className="break-all">{message.text}</span>
        </div>
      )}

      {/* 总开关 */}
      <div className={cardClass}>
        {renderRow(
          '启用同步',
          '关闭后不会上传或下载任何数据',
          settings.enabled,
          () => update({ enabled: !settings.enabled })
        )}
        <div className="h-[1px] bg-slate-300/20 my-3" />
        {renderRow(
          '数据变化后自动上传',
          '编辑书籍、设置或人设后自动同步一次',
          settings.autoSync,
          () => update({ autoSync: !settings.autoSync }),
          !settings.enabled
        )}
      </div>

      {/* 选择后端 */}
      <div className="space-y-2">
        <div className="text-xs font-bold text-slate-400 uppercase tracking-wider px-1">同步方式</div>
        {listProviders().map((item) => {
          const Icon = PROVIDER_ICONS[item.id];
          const selected = settings.provider === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => update({ provider: item.id })}
              className={`w-full p-3 rounded-xl text-left flex items-start gap-3 border-2 transition-colors ${
                selected
                  ? 'border-rose-300 bg-rose-50/50 dark:bg-rose-900/10'
                  : isDarkMode
                    ? 'border-transparent bg-zinc-800/50'
                    : 'border-transparent bg-gray-50'
              }`}
            >
              <Icon className={`w-5 h-5 mt-0.5 ${selected ? 'text-rose-400' : 'text-slate-400'}`} />
              <div className="min-w-0">
                <div className="text-sm font-medium">{item.label}</div>
                <div className={hintClass}>{PROVIDER_SUMMARY[item.id]}</div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Supabase 配置 */}
      {settings.provider === 'supabase' && (
        <div className={`space-y-4 ${cardClass}`}>
          <div>
            <label className={labelClass}>项目地址</label>
            <input
              className={inputClass}
              placeholder="https://xxxxxxxx.supabase.co"
              value={settings.supabaseUrl}
              onChange={(event) => update({ supabaseUrl: event.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>anon key</label>
            <input
              className={inputClass}
              placeholder="eyJhbGciOi..."
              value={settings.supabaseAnonKey}
              onChange={(event) => update({ supabaseAnonKey: event.target.value })}
            />
            <p className={hintClass}>
              anon key 设计上就是放在前端的，真正的访问控制由行级安全策略决定。请勿填写 service_role key。
            </p>
          </div>
          <div>
            <label className={labelClass}>登录邮箱</label>
            <input
              className={inputClass}
              type="email"
              placeholder="you@example.com"
              value={settings.supabaseEmail}
              onChange={(event) => update({ supabaseEmail: event.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>登录密码</label>
            <input
              className={inputClass}
              type="password"
              placeholder={settings.supabaseRefreshToken ? '已保持登录，可留空' : 'Supabase 账号密码'}
              value={passwordDraft}
              onChange={(event) => setPasswordDraft(event.target.value)}
            />
            <p className={hintClass}>
              登录成功后只保留可撤销的刷新令牌，密码不会写入本地存储。
            </p>
          </div>
          <div>
            <label className={labelClass}>存储桶名称</label>
            <input
              className={inputClass}
              placeholder={DEFAULT_SUPABASE_BUCKET}
              value={settings.supabaseBucket}
              onChange={(event) => update({ supabaseBucket: event.target.value })}
            />
          </div>
        </div>
      )}

      {/* Gist 配置 */}
      {settings.provider === 'gist' && (
        <div className={`space-y-4 ${cardClass}`}>
          <div>
            <label className={labelClass}>GitHub Token</label>
            <input
              className={inputClass}
              type="password"
              placeholder="ghp_xxxxxxxxxx"
              value={settings.githubToken}
              onChange={(event) => update({ githubToken: event.target.value })}
            />
            <p className={hintClass}>只需授予 gist 权限，Token 仅保存在本机。</p>
          </div>
          <div>
            <label className={labelClass}>同步 Gist ID</label>
            <input
              className={inputClass}
              placeholder="留空会自动创建"
              value={settings.gistId}
              onChange={(event) => update({ gistId: event.target.value })}
            />
          </div>
          <div>
            <label className={labelClass}>CORS 代理地址</label>
            <input
              className={inputClass}
              placeholder="https://your-worker.workers.dev"
              value={settings.proxyUrl}
              onChange={(event) => update({ proxyUrl: event.target.value })}
            />
            <p className={hintClass}>浏览器直连 GitHub 失败时，可填写一个中转服务地址。</p>
          </div>
          {renderRow(
            '使用代理',
            '仅当上面的地址已填写时生效',
            settings.useProxy,
            () => update({ useProxy: !settings.useProxy })
          )}
        </div>
      )}

      {/* 加密 */}
      <div className={`space-y-3 ${cardClass}`}>
        <div className="flex items-center gap-2">
          <Lock className="w-4 h-4 text-emerald-500" />
          <span className="text-sm font-medium">同步密码</span>
        </div>
        <input
          className={inputClass}
          type="password"
          placeholder="用于加密云端存档"
          value={settings.syncPassword}
          onChange={(event) => update({ syncPassword: event.target.value })}
        />
        <p className={hintClass}>
          存档在上传前会在这台设备上加密，云端和任何中转服务都只能看到密文。
          新设备首次恢复时必须输入同一个密码，请务必自行备份。为实现自动同步，密码会保存在当前浏览器本地，
          请只在你信任的设备上启用。
        </p>
        <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
          <ShieldCheck className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>忘记同步密码将无法恢复云端存档，这是加密设计的一部分。</span>
        </div>
      </div>

      {/* 同步内容 */}
      <div className={`space-y-3 ${cardClass}`}>
        <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">同步内容</div>
        {renderRow(
          '书籍正文',
          '体积通常较大；聊天、笔记和阅读状态始终同步',
          settings.includeBookContents,
          () => update({ includeBookContents: !settings.includeBookContents })
        )}
        <div className="h-[1px] bg-slate-300/20" />
        {renderRow(
          '图片与封面',
          '开启后存档体积会显著增大',
          settings.includeImages,
          () => update({ includeImages: !settings.includeImages })
        )}
        <div className="h-[1px] bg-slate-300/20" />
        {renderRow(
          'TTS 朗读音频',
          '可以重新生成，建议保持关闭以节省流量',
          settings.includeTtsAudio,
          () => update({ includeTtsAudio: !settings.includeTtsAudio })
        )}
        <div className="h-[1px] bg-slate-300/20" />
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium">保留历史版本</div>
            <div className={hintClass}>超出数量后自动清理较早的云端版本</div>
          </div>
          <select
            className={`px-3 py-1.5 rounded-lg border text-sm ${isDarkMode ? 'bg-zinc-900 border-zinc-700 text-zinc-100' : 'bg-white border-gray-200 text-gray-800'}`}
            value={settings.keepVersions}
            onChange={(event) => update({ keepVersions: Number(event.target.value) })}
          >
            {[1, 3, 5, 10, 20].map((count) => (
              <option key={count} value={count}>
                {count} 个
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 操作 */}
      {configError && (
        <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 text-sm flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{configError}</span>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={!!configError || busy.kind === 'testing'}
          onClick={handleTest}
          className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy.kind === 'testing' ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          测试连接
        </button>
        <button
          type="button"
          disabled={!!configError || busy.kind === 'versions'}
          onClick={handleLoadVersions}
          className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy.kind === 'versions' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Cloud className="w-4 h-4" />}
          云端版本
        </button>
        <button
          type="button"
          disabled={syncDisabled}
          onClick={() => handleSync('push')}
          className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-rose-400 text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy.kind === 'sync' && busy.direction === 'push' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Upload className="w-4 h-4" />
          )}
          立即上传
        </button>
        <button
          type="button"
          disabled={syncDisabled}
          onClick={() => handleSync('pull')}
          className="flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy.kind === 'sync' && busy.direction === 'pull' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Download className="w-4 h-4" />
          )}
          从云端恢复
        </button>
      </div>

      <button
        type="button"
        disabled={syncDisabled}
        onClick={() => handleSync('both')}
        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy.kind === 'sync' && busy.direction === 'both' ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <RefreshCw className="w-4 h-4" />
        )}
        智能同步（推荐）
      </button>
      <p className={hintClass + ' text-center'}>
        智能同步会依据上次成功同步的版本判断变化；若两端都修改过，会停止并让你选择。
      </p>

      {/* 云端版本列表 */}
      {versions && (
        <div className={`space-y-2 ${cardClass}`}>
          <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">云端历史版本</div>
          {versions.length === 0 ? (
            <p className={hintClass}>云端还没有任何存档，点击「立即上传」创建第一份。</p>
          ) : (
            versions.map((entry) => (
              <div key={entry.id} className="flex items-center justify-between text-sm gap-3">
                <div className="min-w-0">
                  <div className="font-medium truncate">
                    {entry.deviceLabel || '未知设备'}
                    {entry.isLocalDevice ? '（本机）' : ''}
                  </div>
                  <div className={hintClass}>
                    {formatSyncTime(entry.syncedAt)} · {entry.encrypted ? '已加密' : '未加密'}
                  </div>
                </div>
                <span className="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">
                  {formatBytes(entry.sizeBytes)}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};

export default SyncSettings;
