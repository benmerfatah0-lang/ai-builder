import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const apiProxy = {
  '/vision-worker.js': { target: 'http://127.0.0.1:8080', changeOrigin: true },
  '/vision': { target: 'http://127.0.0.1:8080', changeOrigin: true },
  '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true, headers: { origin: 'http://127.0.0.1:8080' } },
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    port: 5173,
    strictPort: true,
    proxy: apiProxy,
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: true,
    port: 4173,
    strictPort: true,
    proxy: apiProxy,
  },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          'three-vendor': ['three'],
          'react-vendor': ['react', 'react-dom'],
          validation: ['zod'],
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['src/test/setup.ts'],
  },
});
