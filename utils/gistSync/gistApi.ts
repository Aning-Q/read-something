import { GIST_FILENAME, GIST_DESCRIPTION } from './types';

const GITHUB_API_BASE = 'https://api.github.com';

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

  const response = await fetch(`${GITHUB_API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

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
    
    throw new GistApiError(errorMessage, response.status);
  }

  return response;
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
