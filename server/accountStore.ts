import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** One encrypted record per Google subject, never served as a static file. */
export class AccountStore {
  constructor(private directory: string, private key: Buffer) {
    if (key.length !== 32) throw new Error('Encryption key must contain 32 bytes.');
  }
  private filename(subject: string): string {
    return join(this.directory, `${createHash('sha256').update(subject).digest('hex')}.json`);
  }
  async save(subject: string, apiKey: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(subject));
    const encrypted = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
    const contents = JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
    const dest = this.filename(subject);
    const temp = `${dest}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temp, contents, { mode: 0o600, flag: 'wx' });
      await rename(temp, dest);
    } finally { await rm(temp, { force: true }); }
  }
  async load(subject: string): Promise<string | null> {
    let raw: string;
    try { raw = await readFile(this.filename(subject), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const data = JSON.parse(raw) as { version: number; iv: string; tag: string; data: string };
    if (data.version !== 1) throw new Error('Unsupported account record');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(data.iv, 'base64'));
    decipher.setAAD(Buffer.from(subject));
    decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data.data, 'base64')), decipher.final()]).toString('utf8');
  }
  async remove(subject: string): Promise<void> { await rm(this.filename(subject), { force: true }); }
}
