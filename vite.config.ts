import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, 'web'),
  build: {
    outDir: resolve(__dirname, 'static'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
      '/admin': 'http://localhost:3001',
    },
  },
});
