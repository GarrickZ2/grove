// API client base configuration
// In dev mode, vite proxy forwards /api to backend
// In prod mode (served by grove web), use relative path
const API_BASE_URL = import.meta.env.VITE_API_URL || '';

export interface ApiError {
  status: number;
  message: string;
  // Parsed JSON body if available
  data?: unknown;
}

type ErrorPayload = { message: string; data?: unknown };

// Try to extract error message (and JSON body) from response
async function extractErrorPayload(response: Response): Promise<ErrorPayload> {
  try {
    const text = await response.text();
    if (text) {
      try {
        const json = JSON.parse(text);
        // Check common error message fields
        return {
          message: json.message || json.error || json.detail || text,
          data: json,
        };
      } catch {
        // Not JSON, return raw text
        return { message: text };
      }
    }
  } catch {
    // Ignore extraction errors
  }
  return { message: response.statusText };
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
      const payload = await extractErrorPayload(response);
      throw {
        status: response.status,
        message: payload.message,
        data: payload.data,
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
      const payload = await extractErrorPayload(response);
      throw {
        status: response.status,
        message: payload.message,
        data: payload.data,
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
      const payload = await extractErrorPayload(response);
      throw {
        status: response.status,
        message: payload.message,
        data: payload.data,
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
      const payload = await extractErrorPayload(response);
      throw {
        status: response.status,
        message: payload.message,
        data: payload.data,
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
      const payload = await extractErrorPayload(response);
      throw {
        status: response.status,
        message: payload.message,
        data: payload.data,
      } as ApiError;
    }

    return response.json();
  }
}

// Default client instance
export const apiClient = new ApiClient();

/// Get the API host for WebSocket connections.
/// In dev mode (VITE_API_URL set), extract host from that URL.
/// In prod mode, use window.location.host.
export function getApiHost(): string {
  const envUrl = import.meta.env.VITE_API_URL;
  if (envUrl) {
    try {
      const url = new URL(envUrl, window.location.origin);
      return url.host;
    } catch {
      // fallback
    }
  }
  return window.location.host;
}
