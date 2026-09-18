const GITHUB_API_BASE = 'https://api.github.com';

// 使用全局方式，避免打包时 tree-shaking 丢失
declare global {
  var __gist_proxy_url: string | undefined;
}

const getApiBase = (): string => {
  if (globalThis.__gist_proxy_url) {
    return globalThis.__gist_proxy_url.replace(/\/$/, '');
  }
  return GITHUB_API_BASE;
};

export interface GistFile {
  filename: string;
  content: string;
  truncated?: boolean;
  raw_url?: string;
}

export interface GistResponse {
  id: string;
  description: string;
  public: boolean;
  files: Record<string, GistFile>;
  updated_at: string;
  created_at: string;
  html_url: string;
}

export type GistFileMap = Record<string, string>;

export class GistApiError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = 'GistApiError';
  }
}

const FETCH_TIMEOUT_MS = 30000;

const fetchWithAuth = async (
  token: string,
  endpoint: string,
  options: RequestInit = {}
): Promise<Response> => {
  const trimmed = (token || '').trim();
  if (!trimmed) throw new GistApiError('GitHub Token 不能为空');

  const headers: Record<string, string> = {
    Authorization: `token ${trimmed}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const response = await fetch(`${getApiBase()}${endpoint}`, {
      ...options,
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      let errorMessage = `请求失败: ${response.status}`;
      try {
        const errorData = await response.json();
        errorMessage = errorData.message || errorMessage;
      } catch {
        // 忽略解析错误
      }
      if (response.status === 401) {
        throw new GistApiError('Token 无效或已过期，请重新配置', response.status);
      }
      if (response.status === 403) {
        throw new GistApiError('Token 权限不足，请确保已授予 gist 权限', response.status);
      }
      if (response.status === 404) {
        throw new GistApiError('Gist 不存在或无访问权限', response.status);
      }
      if (response.status === 422) {
        throw new GistApiError('数据量过大，已超出 Gist 限制', response.status);
      }
      throw new GistApiError(errorMessage, response.status);
    }
    return response;
  } catch (error) {
    if (error instanceof GistApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new GistApiError('请求超时，请检查网络后重试');
    }
    throw new GistApiError(
      '网络连接失败，请检查网络或关闭代理/VPN后重试。如仍有问题，请尝试重新生成 GitHub Token。'
    );
  }
};

export const testToken = async (token: string): Promise<boolean> => {
  await fetchWithAuth(token, '/user');
  return true;
};

/** 按文件名查找同步 Gist，用于在一台新设备上找回已有存档。 */
export const findGistByFileName = async (
  token: string,
  fileName: string
): Promise<string | null> => {
  const response = await fetchWithAuth(token, '/gists?per_page=100');
  const gists: GistResponse[] = await response.json();
  for (const gist of gists) {
    if (gist.files?.[fileName]) return gist.id;
  }
  return null;
};

/** 读取 Gist 中全部文件内容。 */
export const getGistFileMap = async (token: string, gistId: string): Promise<GistFileMap> => {
  const response = await fetchWithAuth(token, `/gists/${gistId}`);
  const gist: GistResponse = await response.json();
  const files: GistFileMap = {};
  Object.entries(gist.files || {}).forEach(([name, file]) => {
    files[name] = file.content ?? '';
  });
  return files;
};

const assertSizeLimit = (files: GistFileMap): void => {
  let totalBytes = 0;
  Object.values(files).forEach((content) => {
    totalBytes += new TextEncoder().encode(content).length;
  });
  if (totalBytes > 1 * 1024 * 1024) {
    throw new GistApiError(
      `同步数据过大 (${(totalBytes / 1024 / 1024).toFixed(2)}MB)，`
        + '请减少同步内容后重试，或改用 Supabase。'
    );
  }
};

const toPayload = (files: GistFileMap): Record<string, { content: string }> => {
  const payload: Record<string, { content: string }> = {};
  Object.entries(files).forEach(([name, content]) => {
    payload[name] = { content };
  });
  return payload;
};

/** 用给定的文件集合新建私有 Gist，返回其 id。 */
export const createGistWithFiles = async (
  token: string,
  description: string,
  files: GistFileMap
): Promise<string> => {
  assertSizeLimit(files);
  const response = await fetchWithAuth(token, '/gists', {
    method: 'POST',
    body: JSON.stringify({ description, public: false, files: toPayload(files) }),
  });
  const gist: GistResponse = await response.json();
  return gist.id;
};

/** 覆盖写入若干文件内容，未列出的文件保持不变。 */
export const updateGistFiles = async (
  token: string,
  gistId: string,
  files: GistFileMap
): Promise<void> => {
  assertSizeLimit(files);
  await fetchWithAuth(token, `/gists/${gistId}`, {
    method: 'PATCH',
    body: JSON.stringify({ files: toPayload(files) }),
  });
};
