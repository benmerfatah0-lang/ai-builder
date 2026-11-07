import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { GenerateAuthUrlOpts } from 'google-auth-library';
import { createAccountApp, loadConfig, type ServerConfig } from './app';
import { AccountStore } from './accountStore';

let directory: string;
let config: ServerConfig;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'world-account-test-'));
  config = { origin: 'http://127.0.0.1:5173', clientId: 'client-id', clientSecret: 'client-secret',
    sessionSecret: 's'.repeat(40), encryptionKey: Buffer.alloc(32, 17), dataDir: directory, trustProxy: false };
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('encrypted account storage', () => {
  it('encrypts per Google subject, persists, and rejects tampering', async () => {
    const store = new AccountStore(directory, config.encryptionKey);
    await store.save('user-one', 'test-private-key');
    const [file] = await readdir(directory);
    const raw = await readFile(join(directory, file!), 'utf8');
    expect(raw).not.toContain('test-private-key');
    expect(await store.load('user-one')).toBe('test-private-key');
    expect(await store.load('user-two')).toBeNull();
    const wrongKeyStore = new AccountStore(directory, Buffer.alloc(32, 18));
    await expect(wrongKeyStore.load('user-one')).rejects.toThrow();
    await store.remove('user-one');
    expect(await store.load('user-one')).toBeNull();
  });
  it('rejects unsafe origins and incomplete encryption settings', () => {
    expect(loadConfig({})).toBeNull();
    expect(() => loadConfig({ APP_ORIGIN: 'http://example.com', GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x', SESSION_SECRET: 'x'.repeat(32), KEY_ENCRYPTION_SECRET: Buffer.alloc(32).toString('base64') })).toThrow();
  });
});

describe('Google login and account API', () => {
  it('rejects wrong OAuth state, then saves and uses a key only for the authenticated account', async () => {
    let captured: GenerateAuthUrlOpts = {};
    const oauth = {
      generateAuthUrl: (options: GenerateAuthUrlOpts) => { captured = options; return 'https://accounts.google.com/mock'; },
      getToken: vi.fn().mockResolvedValue({ tokens: { id_token: 'id-token' } }),
      verifyIdToken: vi.fn().mockImplementation(async () => ({ getPayload: () => ({ sub: 'google-user', nonce: captured.nonce, name: 'User' }) })),
    };
    const upstream = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'completed', output: [] }), { status: 200 }));
    const app = createAccountApp({ config, oauth, upstreamFetch: upstream, staticDir: directory });
    const agent = request.agent(app);
    expect((await agent.get('/api/session')).body.signedIn).toBe(false);
    expect((await agent.put('/api/account/key').send({ apiKey: 'test-secret-key' })).status).toBe(401);
    await agent.get('/api/auth/google');
    expect(captured.code_challenge_method).toBe('S256');
    expect(captured.scope).toEqual(['openid', 'profile']);
    const wrong = await agent.get('/api/auth/google/callback?code=test&state=wrong');
    expect(wrong.headers.location).toBe('/?auth_error=login');
    expect(oauth.getToken).not.toHaveBeenCalled();
    await agent.get('/api/auth/google');
    await agent.get('/api/auth/google/callback').query({ code: 'test', state: captured.state });
    const session = (await agent.get('/api/session')).body as { signedIn: boolean; hasKey: boolean; csrfToken: string; name: string };
    expect(session.signedIn).toBe(true);
    expect(session.hasKey).toBe(false);
    expect(session.name).toBe('User');
    const api = () => agent.put('/api/account/key').set('Origin', config.origin).send({ apiKey: 'test-secret-key' });
    expect((await api()).status).toBe(403);
    expect((await api().set('X-CSRF-Token', session.csrfToken).set('Origin', 'https://evil.example')).status).toBe(403);
    expect((await api().set('X-CSRF-Token', session.csrfToken)).status).toBe(200);
    const sessionAfter = await agent.get('/api/session');
    expect(sessionAfter.body.hasKey).toBe(true);
    expect(JSON.stringify(sessionAfter.body)).not.toContain('test-secret-key');
    expect((await readFile(join(directory, (await readdir(directory))[0]!), 'utf8'))).not.toContain('test-secret-key');
    const ai = await agent.post('/api/ai/plan').set('Origin', config.origin).set('X-CSRF-Token', session.csrfToken).send({ prompt: 'بيت' });
    expect(ai.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    const init = upstream.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-secret-key');
    expect(JSON.parse(init.body as string).model).toBe('gpt-4.1-mini');
    const deleted = await agent.delete('/api/account/key').set('Origin', config.origin).set('X-CSRF-Token', session.csrfToken);
    expect(deleted.status).toBe(200);
    expect((await agent.get('/api/session')).body.hasKey).toBe(false);
    expect((await agent.post('/api/auth/logout').set('Origin', config.origin).set('X-CSRF-Token', session.csrfToken)).status).toBe(200);
    expect((await agent.get('/api/session')).body.signedIn).toBe(false);
  });
  it('keeps account APIs disabled until configured', async () => {
    const app = createAccountApp({ config: null, staticDir: directory });
    expect((await request(app).get('/api/session')).body.configured).toBe(false);
    expect((await request(app).get('/api/auth/google')).status).toBe(503);
  });
});
