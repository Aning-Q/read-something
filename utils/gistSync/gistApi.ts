import { GIST_FILENAME, GIST_DESCRIPTION } from './types';

const GITHUB_API_BASE = 'https://api.github.com';

// 使用全局方式，避免打包时 tree-shaking 丢失
declare global {
  var __gist_proxy_url: string | undefined;
}

// 获取实际的 API 基础 URL
const getApiBase = (): string => {
  if (globalThis.__gist_proxy_url) {
    return globalThis.__gist_proxy_url.replace(/\/$/, '');
  }
  return GITHUB_API_BASE;
};

export const setProxyUrl = (url: string | null): void => {
  globalThis.__gist_proxy_url = url?.trim() || undefined;
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

export class GistApiError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = 'GistApiError';
  }
}

const validateToken = (token: string): void => {
  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    throw new GistApiError('GitHub Token 不能为空');
  }
  if (!/^[a-zA-Z0-9_]+$/.test(token.trim()) && !token.includes('ghp_') && !token.includes('github_pat_')) {
    // 宽松验证，只检查非空
  }
};

// 超时时间：30秒
const FETCH_TIMEOUT_MS = 30000;

const fetchWithAuth = async (
  token: string,
  endpoint: string,
  options: RequestInit = {}
): Promise<Response> => {
  validateToken(token);
  
  const headers: Record<string, string> = {
    'Authorization': `token ${token.trim()}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  try {
    // 使用 AbortController 实现超时
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
    if (error instanceof GistApiError) {
      throw error;
    }
    
    // 处理网络错误和超时
    if (error instanceof Error && error.name === 'AbortError') {
      throw new GistApiError('请求超时，请检查网络后重试');
    }
    
    // CORS / 网络错误
    throw new GistApiError(
      '网络连接失败，请检查网络或关闭代理/VPN后重试。' +
      '如仍有问题，请尝试重新生成 GitHub Token。'
    );
  }
};

export const testToken = async (token: string): Promise<boolean> => {
  try {
    await fetchWithAuth(token, '/user');
    return true;
  } catch (error) {
    if (error instanceof GistApiError) {
      throw error;
    }
    throw new GistApiError('网络请求失败，请检查网络连接');
  }
};

export const findSyncGist = async (token: string): Promise<string | null> => {
  const response = await fetchWithAuth(token, '/gists?per_page=100');
  const gists: GistResponse[] = await response.json();
  
  for (const gist of gists) {
    if (gist.files[GIST_FILENAME] && !gist.public) {
      return gist.id;
    }
  }
  
  return null;
};

export const createSyncGist = async (token: string, initialContent: string): Promise<string> => {
  const response = await fetchWithAuth(token, '/gists', {
    method: 'POST',
    body: JSON.stringify({
      description: GIST_DESCRIPTION,
      public: false,
      files: {
        [GIST_FILENAME]: {
          content: initialContent,
        },
      },
    }),
  });
  
  const gist: GistResponse = await response.json();
  return gist.id;
};

export const getGistContent = async (
  token: string,
  gistId: string
): Promise<{ content: string; updatedAt: number }> => {
  const response = await fetchWithAuth(token, `/gists/${gistId}`);
  const gist: GistResponse = await response.json();
  
  const file = gist.files[GIST_FILENAME];
  if (!file) {
    throw new GistApiError('Gist 中未找到同步文件');
  }

  let content = file.content;
  
  if (file.truncated && file.raw_url) {
    const rawResponse = await fetch(file.raw_url, {
      headers: { Authorization: `token ${token.trim()}` },
    });
    if (rawResponse.ok) {
      content = await rawResponse.text();
    }
  }
  
  return {
    content,
    updatedAt: new Date(gist.updated_at).getTime(),
  };
};

export const updateGistContent = async (
  token: string,
  gistId: string,
  content: string
): Promise<void> => {
  // 检查大小：GitHub Gist 单文件建议不超过 1MB
  // 超过 1MB 的文件需要从 raw_url 二次请求，同步会变慢
  const size = new TextEncoder().encode(content).length;
  if (size > 5 * 1024 * 1024) {
    throw new GistApiError(
      `同步数据过大 (${(size / 1024 / 1024).toFixed(1)}MB)，` +
      '请减少书籍数量或删除不需要的聊天记录后重试。'
    );
  }
  
  await fetchWithAuth(token, `/gists/${gistId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      files: {
        [GIST_FILENAME]: {
          content,
        },
      },
    }),
  });
};

export const deleteGist = async (token: string, gistId: string): Promise<void> => {
  await fetchWithAuth(token, `/gists/${gistId}`, {
    method: 'DELETE',
  });
};
