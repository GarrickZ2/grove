import { defineConfig } from 'vite'
import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [
    react({
      babel: {
        plugins: [
          ['babel-plugin-react-compiler', {
            // Set REACT_COMPILER_LOG=1 in your shell to see per-file
            // bailout reasons during build. Silent by default to keep
            // normal CI / dev output clean.
            ...(process.env.REACT_COMPILER_LOG ? {
              logger: {
                logEvent(filename: string, event: { kind: string; fnLoc?: { start?: { line?: number } }; detail?: { reason?: string; description?: string; loc?: { start?: { line?: number } } | string } }) {
                  if (event.kind === 'CompileError' || event.kind === 'CompileSkip') {
                    const fnLine = event.fnLoc?.start?.line
                    const loc = event.detail?.loc
                    const errLine = typeof loc === 'object' && loc?.start?.line
                    // eslint-disable-next-line no-console
                    console.warn('[react-compiler]', event.kind, filename, `fn:${fnLine ?? '?'}${errLine ? ` err:${errLine}` : ''}`, event.detail?.reason ?? '', event.detail?.description ?? '')
                  }
                },
              },
            } : {}),
          }],
        ],
      },
    }),
    tailwindcss(),
  ],
  // In perf mode, swap react-dom for the profiling-enabled build so
  // <Profiler onRender> actually fires in our perf-build bundle. The
  // alias is gated on mode === "perf" so a normal `npm run build` is
  // bit-for-bit identical to before.
  resolve: mode === 'perf' ? {
    alias: {
      'react-dom/client': 'react-dom/profiling',
    },
  } : undefined,
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        radio: resolve(__dirname, 'radio.html'),
        tray: resolve(__dirname, 'tray.html'),
      },
    },
  },
  server: {
    proxy: {
      // Proxy API requests to the backend
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // Enable WebSocket proxying
        ws: true,
      },
    },
  },
}))
