#!/usr/bin/env node
/**
 * Zero-dependency static server for the project site.
 *
 * Serves `website/` at `/` and the production build of the editor at `/app/`.
 * Binds 0.0.0.0 so it works behind the sandbox preview proxy (and on a phone
 * on the same network).
 *
 *   node website/server.mjs [--port 4173]
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
// Everything served to the public lives in `website/public`; the source of the
// playground bundle is `website/src`.
const root = resolve(here, 'public');
const appRoot = join(root, 'app');

// 4173 is the port this deployment exposes as its live preview.
const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
const port = Number(portFlag >= 0 ? args[portFlag + 1] : process.env.PORT ?? 4173);
const host = process.env.HOST ?? '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** Resolve a URL path to a file inside `base`, refusing traversal. */
function safeFile(base, pathname) {
  const decoded = decodeURIComponent(pathname);
  const candidate = normalize(join(base, decoded));
  if (!candidate.startsWith(base + sep) && candidate !== base) return null;
  return candidate;
}

function serveFile(res, file, { immutable = false } = {}) {
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': statSync(file).size,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let pathname = url.pathname;

  // The editor is a single-page app built with base "/app/".
  if (pathname === '/app') {
    res.writeHead(302, { Location: '/app/' });
    res.end();
    return;
  }

  if (pathname.startsWith('/app/')) {
    const relative = pathname.slice('/app'.length);
    const target = safeFile(appRoot, relative);
    if (!target) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (existsSync(target) && statSync(target).isFile()) {
      serveFile(res, target, { immutable: pathname.includes('/assets/') });
      return;
    }
    // Client-side route fallback for the editor shell.
    const shell = join(appRoot, 'index.html');
    if (existsSync(shell) && !pathname.includes('.')) {
      serveFile(res, shell);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(
      'The editor build is missing. Run `npm run site:app` to build it into website/public/app.\n',
    );
    return;
  }

  if (pathname === '/') pathname = '/index.html';
  const file = safeFile(root, pathname);
  if (!file) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (existsSync(file) && statSync(file).isFile()) {
    serveFile(res, file);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(port, host, () => {
  console.log(`Project site:  http://${host}:${port}/`);
  console.log(`Editor build:  http://${host}:${port}/app/`);
  if (!existsSync(join(appRoot, 'index.html'))) {
    console.log('note: website/public/app is missing — run `npm run site:app`.');
  }
  if (!existsSync(join(root, 'demo.js'))) {
    console.log('note: website/public/demo.js is missing — run `npm run site:demo`.');
  }
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
