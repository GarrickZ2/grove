// API client base configuration
// In dev mode, vite proxy forwards /api to backend
// In prod mode (served by grove web), use relative path
const API_BASE_URL = import.meta.env.VITE_API_URL || '';

export interface ApiError {
  status: number;
  message: string;
}

// Try to extract error message from response body
async function extractErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (text) {
      try {
        const json = JSON.parse(text);
        // Check common error message fields
        return json.message || json.error || json.detail || text;
      } catch {
        // Not JSON, return raw text
        return text;
      }
    }
  } catch {
    // Ignore extraction errors
  }
  return response.statusText;
}

export class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string = API_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const message = await extractErrorMessage(response);
      throw {
        status: response.status,
        message,
      } as ApiError;
    }

    return response.json();
  }

  async patch<T, R>(path: string, data: T): Promise<R> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const message = await extractErrorMessage(response);
      throw {
        status: response.status,
        message,
      } as ApiError;
    }

    return response.json();
  }

  async post<T, R>(path: string, data?: T): Promise<R> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: data ? JSON.stringify(data) : undefined,
    });

    if (!response.ok) {
      const message = await extractErrorMessage(response);
      throw {
        status: response.status,
        message,
      } as ApiError;
    }

    return response.json();
  }

  async delete<T = void>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const message = await extractErrorMessage(response);
      throw {
        status: response.status,
        message,
      } as ApiError;
    }

    // Try to parse JSON response, return undefined for void type
    const text = await response.text();
    if (text) {
      return JSON.parse(text) as T;
    }
    return undefined as T;
  }

  async put<T, R>(path: string, data: T): Promise<R> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const message = await extractErrorMessage(response);
      throw {
        status: response.status,
        message,
      } as ApiError;
    }

    return response.json();
  }
}

// Default client instance
export const apiClient = new ApiClient();
