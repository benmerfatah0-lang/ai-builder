import express from 'express';
import session from 'express-session';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import { AccountStore } from './accountStore';
import { createOnlineRequest } from '../src/modules/ai/onlineRequest';

declare module 'express-session' {
  interface SessionData {
    oauth?: { state: string; nonce: string; verifier: string; started: number };
    account?: { sub: string; name: string; csrf: string };
  }
}
export interface ServerConfig {
  origin: string; clientId: string; clientSecret: string; sessionSecret: string;
  encryptionKey: Buffer; dataDir: string; trustProxy: boolean;
}
export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig | null {
  if (!env.APP_ORIGIN || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.SESSION_SECRET || !env.KEY_ENCRYPTION_SECRET) return null;
  const url = new URL(env.APP_ORIGIN);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.origin !== env.APP_ORIGIN) {
    throw new Error('APP_ORIGIN must be a bare HTTPS origin (HTTP only for localhost).');
  }
  const key = Buffer.from(env.KEY_ENCRYPTION_SECRET, 'base64');
  if (key.length !== 32 || env.SESSION_SECRET.length < 32) throw new Error('Use a 32-byte base64 KEY_ENCRYPTION_SECRET and a SESSION_SECRET of at least 32 characters.');
  return { origin: url.origin, clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET,
    sessionSecret: env.SESSION_SECRET, encryptionKey: key,
    dataDir: resolve(env.DATA_DIR ?? 'data/private-accounts'), trustProxy: env.TRUST_PROXY === '1' };
}

interface OAuthAdapter {
  generateAuthUrl(options: Parameters<OAuth2Client['generateAuthUrl']>[0]): string;
  getToken(options: { code: string; codeVerifier: string }): Promise<{ tokens: { id_token?: string | null } }>;
  verifyIdToken(options: { idToken: string; audience: string }): Promise<{ getPayload(): { sub?: string; nonce?: string; name?: string } | undefined }>;
}
interface AppOptions { config: ServerConfig | null; oauth?: OAuthAdapter; upstreamFetch?: typeof fetch; staticDir?: string }
const random = () => randomBytes(32).toString('base64url');
function same(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createAccountApp({ config, oauth, upstreamFetch = fetch, staticDir = resolve('dist') }: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  if (config?.trustProxy) app.set('trust proxy', 1);
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('X-Content-Type-Options', 'nosniff'); next(); });
  app.use('/api', express.json({ limit: '8kb' }));
  const store = config ? new AccountStore(config.dataDir, config.encryptionKey) : null;
  const client: OAuthAdapter | null = config ? oauth ?? new OAuth2Client(config.clientId, config.clientSecret, `${config.origin}/api/auth/google/callback`) : null;
  app.use('/api', session({
    name: 'world_session', secret: config?.sessionSecret ?? random(), resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config?.origin.startsWith('https:') ?? false, maxAge: 8 * 60 * 60 * 1000 },
  }));
  const requireAccount: express.RequestHandler = (req, res, next) => {
    if (!config || !store) { res.status(503).json({ error: 'account_not_configured' }); return; }
    if (!req.session.account) { res.status(401).json({ error: 'not_signed_in' }); return; }
    if (req.get('origin') !== config.origin || !same(req.get('x-csrf-token') ?? '', req.session.account.csrf)) {
      res.status(403).json({ error: 'invalid_request' }); return;
    }
    next();
  };
  app.get('/api/session', async (req, res) => {
    if (!config || !store) { res.json({ configured: false, signedIn: false, hasKey: false }); return; }
    const account = req.session.account;
    if (!account) { res.json({ configured: true, signedIn: false, hasKey: false }); return; }
    try { res.json({ configured: true, signedIn: true, name: account.name, csrfToken: account.csrf, hasKey: Boolean(await store.load(account.sub)) }); }
    catch { res.status(500).json({ error: 'account_storage_error' }); }
  });
  app.get('/api/auth/google', (req, res) => {
    if (!config || !client) { res.status(503).send('Google login is not configured.'); return; }
    const state = random(), nonce = random(), verifier = random();
    const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
    req.session.oauth = { state, nonce, verifier, started: Date.now() };
    const url = client.generateAuthUrl({ scope: ['openid', 'profile'], state, nonce, code_challenge: codeChallenge, code_challenge_method: CodeChallengeMethod.S256 });
    req.session.save((error) => error ? res.status(500).end() : res.redirect(url));
  });
  app.get('/api/auth/google/callback', async (req, res) => {
    const attempt = req.session.oauth;
    delete req.session.oauth;
    if (!config || !client || !attempt || Date.now() - attempt.started > 10 * 60 * 1000 ||
        typeof req.query.state !== 'string' || !same(req.query.state, attempt.state) || typeof req.query.code !== 'string') {
      res.redirect('/?auth_error=login'); return;
    }
    try {
      const { tokens } = await client.getToken({ code: req.query.code, codeVerifier: attempt.verifier });
      if (!tokens.id_token) throw new Error('Missing ID token');
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.clientId });
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload.nonce || !same(payload.nonce, attempt.nonce)) throw new Error('Invalid nonce');
      const account = { sub: payload.sub, name: (payload.name ?? 'Google').slice(0, 100), csrf: random() };
      req.session.regenerate((error) => {
        if (error) { res.redirect('/?auth_error=login'); return; }
        req.session.account = account;
        req.session.save((saveError) => res.redirect(saveError ? '/?auth_error=login' : '/'));
      });
    } catch { res.redirect('/?auth_error=login'); }
  });
  app.put('/api/account/key', requireAccount, async (req, res) => {
    const value: unknown = req.body?.apiKey;
    if (typeof value !== 'string' || value.trim().length < 10 || value.length > 512 || /[\r\n]/.test(value)) {
      res.status(400).json({ error: 'invalid_key' }); return;
    }
    try { await store!.save(req.session.account!.sub, value.trim()); res.json({ saved: true }); }
    catch { res.status(500).json({ error: 'account_storage_error' }); }
  });
  app.delete('/api/account/key', requireAccount, async (req, res) => {
    try { await store!.remove(req.session.account!.sub); res.json({ deleted: true }); }
    catch { res.status(500).json({ error: 'account_storage_error' }); }
  });
  app.post('/api/auth/logout', requireAccount, (req, res) => {
    req.session.destroy(() => { res.clearCookie('world_session', { path: '/' }); res.json({ signedOut: true }); });
  });
  // Prevent a leaked session or browser tab from using unlimited AI requests.
  const requests = new Map<string, { count: number; reset: number }>();
  app.post('/api/ai/plan', requireAccount, async (req, res) => {
    const prompt: unknown = req.body?.prompt;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 400) { res.status(400).json({ error: 'invalid_prompt' }); return; }
    const sub = req.session.account!.sub, now = Date.now();
    if (requests.size > 5000) for (const [key, value] of requests) if (value.reset < now) requests.delete(key);
    const limit = requests.get(sub);
    if (limit && limit.reset > now && limit.count >= 10) { res.status(429).json({ error: 'rate_limited' }); return; }
    requests.set(sub, !limit || limit.reset < now ? { count: 1, reset: now + 60000 } : { ...limit, count: limit.count + 1 });
    try {
      const key = await store!.load(sub);
      if (!key) { res.status(400).json({ error: 'missing_saved_key' }); return; }
      const response = await upstreamFetch('https://api.openai.com/v1/responses', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(createOnlineRequest(prompt)), signal: AbortSignal.timeout(90000),
      });
      if (!response.ok) { res.set('X-AI-Upstream-Status', String(response.status)); res.status(response.status >= 400 && response.status < 600 ? response.status : 502).json({ error: 'upstream_error' }); return; }
      const body = await response.text();
      if (body.length > 2_000_000) { res.status(502).json({ error: 'response_too_large' }); return; }
      res.type('application/json').send(body);
    } catch { res.status(502).json({ error: 'upstream_error' }); }
  });
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'not_found' }); });
  app.use(express.static(staticDir, { index: 'index.html' }));
  return app;
}
