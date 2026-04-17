import { apiClient } from './client';
import type { ApiError } from './client';

export interface RenderD2Error {
  code: 'd2_not_installed' | 'render_failed';
  message: string;
}

/**
 * Render D2 source to SVG via the backend.
 * Resolves with SVG string on success.
 * Rejects with RenderD2Error on failure.
 */
export async function renderD2(source: string): Promise<string> {
  try {
    const result = await apiClient.post<{ source: string }, { svg: string }>(
      '/api/v1/render/d2',
      { source }
    );
    return result.svg;
  } catch (err) {
    const apiErr = err as ApiError;
    const body = apiErr.data as RenderD2Error | undefined;
    throw {
      code: body?.code ?? 'render_failed',
      message: body?.message ?? apiErr.message ?? 'Network error',
    } as RenderD2Error;
  }
}
