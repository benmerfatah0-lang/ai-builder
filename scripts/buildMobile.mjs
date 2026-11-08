// Produce the self-contained HTML download used on phones and in Termux.
import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';

const result = await build({
  entryPoints: ['src/main.tsx'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2020',
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: 'app.js',
  write: false,
});
const js = result.outputFiles.find((file) => file.path.endsWith('.js'))?.text;
const css = result.outputFiles.find((file) => file.path.endsWith('.css'))?.text;
if (!js || !css) throw new Error('The mobile bundle did not contain both JavaScript and CSS.');
const html = `<!doctype html><html lang="ar"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#090612"><title>WorldForge - منشئ العوالم</title><style>${css.replace(/<\/style/gi, '<\\/style')}</style></head><body><div id="root"></div><script>${js.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
await writeFile('world-builder-mobile.html', html);
console.log('Built world-builder-mobile.html');
