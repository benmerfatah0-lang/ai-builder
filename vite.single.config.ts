import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Builds the 3D map as ONE self-contained `.html` file that runs from `file://`.
 *
 * Why this config exists: the normal build emits ES modules, and browsers
 * refuse to load a `type="module"` script over `file://` (CORS). That makes the
 * committed `dist/game-map.html` useless to anyone who just downloads the repo
 * and double-clicks it. Emitting a single IIFE bundle with everything inlined -
 * JS, CSS, and the map's own data - produces a file that opens with a double
 * click on desktop and mobile, with no server, no Node, and no network.
 *
 * `npm run build:single` writes `map-3d.html` at the repo root.
 */
export default defineConfig({
  plugins: [react()],
  // Relative URLs so the inlined page has no absolute-path assumptions left.
  base: './',
  build: {
    outDir: 'dist-single',
    emptyOutDir: true,
    // One file, no code splitting: a `file://` page must not fetch siblings,
    // because some browsers block those regardless of the CORS settings.
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: 'game-map.html',
      output: {
        // IIFE, not ESM: `file://` cannot import modules.
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'map.js',
        assetFileNames: 'map.[ext]',
      },
    },
  },
});
