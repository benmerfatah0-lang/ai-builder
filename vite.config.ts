import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Sends the preview's root URL straight to the game map.
 *
 * The repo ships two entry points (`index.html` = the world-builder editor,
 * `game-map.html` = the map deliverable). When the map is what is being
 * previewed, the bare preview host would otherwise land on the editor and hide
 * the map behind a URL the reviewer has to know. This middleware is opt-in via
 * `MAP_PREVIEW=1`, so `npm run dev` still opens the editor exactly as before.
 */
function mapLandingRedirect(): Plugin {
  const redirect = (
    req: { url?: string },
    res: { writeHead: (status: number, headers: Record<string, string>) => void; end: () => void },
    next: () => void,
  ) => {
    const url = req.url ?? '/';
    if (url === '/' || url.startsWith('/?')) {
      res.writeHead(302, { Location: `/game-map.html${url.slice(1)}` });
      res.end();
      return;
    }
    next();
  };
  return {
    name: 'game-map-landing-redirect',
    configureServer(server) {
      server.middlewares.use(redirect);
    },
    configurePreviewServer(server) {
      server.middlewares.use(redirect);
    },
  };
}

const mapPreview = process.env.MAP_PREVIEW === '1';

export default defineConfig({
  plugins: [react(), ...(mapPreview ? [mapLandingRedirect()] : [])],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: true,
    port: 4173,
    strictPort: true,
  },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        main: 'index.html',
        gameMap: 'game-map.html',
      },
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
