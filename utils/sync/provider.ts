import { SyncConnectionSettings, SyncManifest, SyncVersionEntry } from './types';

export interface RemoteObjectPayload {
  blob: Blob;
  /** 远程记录的最近更新时间，用于判断「谁更新」。 */
  updatedAt: number;
}

/**
 * 同步后端只负责「存取一份文件 + 记录版本」，不关心内容格式。
 * 这样切换网盘或自建服务时，只需新增一个实现。
 */
export interface SyncProvider {
  readonly id: string;
  readonly label: string;

  /** 校验配置是否完整，缺失时给出面向用户的提示。 */
  validateSettings(settings: SyncConnectionSettings): string | null;

  /** 连通性测试，用于设置页的「测试连接」。 */
  testConnection(settings: SyncConnectionSettings): Promise<void>;

  /** 读取清单；远端为空时返回一份全新清单。 */
  readManifest(settings: SyncConnectionSettings): Promise<SyncManifest>;

  /** 写入清单。 */
  writeManifest(settings: SyncConnectionSettings, manifest: SyncManifest): Promise<void>;

  /** 上传一份新的存档数据，返回生成的版本记录。 */
  uploadPayload(
    settings: SyncConnectionSettings,
    blob: Blob,
    info: { syncedAt: number; encrypted: boolean }
  ): Promise<SyncVersionEntry>;

  /** 下载指定版本的存档。 */
  downloadPayload(settings: SyncConnectionSettings, objectName: string): Promise<RemoteObjectPayload>;

  /** 删除不再保留的历史版本。 */
  deleteObjects(settings: SyncConnectionSettings, objectNames: string[]): Promise<void>;
}
