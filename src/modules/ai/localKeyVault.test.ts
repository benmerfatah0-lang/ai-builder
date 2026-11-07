import { describe, expect, it } from 'vitest';
import { deleteLocalKey, hasLocalKey, saveLocalKey, unlockLocalKey } from './localKeyVault';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; }, clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe('encrypted phone key vault', () => {
  it('encrypts a key locally, unlocks it with the passphrase and deletes it', async () => {
    const storage = memoryStorage();
    expect(hasLocalKey(storage)).toBe(false);
    await saveLocalKey('test-secret-api-key', 'long password', storage);
    expect(hasLocalKey(storage)).toBe(true);
    const record = storage.getItem(storage.key(0)!)!;
    expect(record).not.toContain('test-secret-api-key');
    expect(record).not.toContain('long password');
    await expect(unlockLocalKey('wrong password', storage)).rejects.toThrow('كلمة المرور');
    expect(await unlockLocalKey('long password', storage)).toBe('test-secret-api-key');
    await saveLocalKey('test-secret-api-key', 'long password', storage);
    expect(storage.getItem(storage.key(0)!)).not.toBe(record);
    deleteLocalKey(storage);
    expect(hasLocalKey(storage)).toBe(false);
  });
  it('rejects weak passphrases without replacing an existing record', async () => {
    const storage = memoryStorage();
    await saveLocalKey('test-secret-api-key', 'long password', storage);
    await expect(saveLocalKey('different-key', 'weak', storage)).rejects.toThrow('8');
    expect(await unlockLocalKey('long password', storage)).toBe('test-secret-api-key');
  });
});
