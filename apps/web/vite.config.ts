import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      // Preserve the browser-facing Host so backend origin checks also work in development.
      '/api': { target: 'http://127.0.0.1:4310', changeOrigin: false },
      '/mcp': { target: 'http://127.0.0.1:4310', changeOrigin: false },
    },
  },
});
