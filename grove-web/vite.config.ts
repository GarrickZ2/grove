import { defineConfig } from 'vite'
import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
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
