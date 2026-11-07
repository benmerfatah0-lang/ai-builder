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
const keys = { groq: 'test-secret-groq-key', tavily: 'test-secret-tavily-key' };
describe('encrypted phone key vault', () => {
  it('encrypts both keys locally, unlocks them with the passphrase and deletes them', async () => {
    const storage = memoryStorage();
    expect(hasLocalKey(storage)).toBe(false);
    await saveLocalKey(keys, 'long password', storage);
    expect(hasLocalKey(storage)).toBe(true);
    const record = storage.getItem(storage.key(0)!)!;
    expect(record).not.toContain(keys.groq);
    expect(record).not.toContain(keys.tavily);
    expect(record).not.toContain('long password');
    await expect(unlockLocalKey('wrong password', storage)).rejects.toThrow('كلمة المرور');
    expect(await unlockLocalKey('long password', storage)).toEqual(keys);
    await saveLocalKey(keys, 'long password', storage);
    expect(storage.getItem(storage.key(0)!)).not.toBe(record);
    deleteLocalKey(storage);
    expect(hasLocalKey(storage)).toBe(false);
  });
  it('does not load or delete old providers vaults', async () => {
    const storage = memoryStorage();
    storage.setItem('worldbuilder.openai-vault.v1', 'old-encrypted-record');
    storage.setItem('worldbuilder.gemini-vault.v1', 'old-encrypted-record-2');
    expect(hasLocalKey(storage)).toBe(false);
    await saveLocalKey(keys, 'long password', storage);
    expect(await unlockLocalKey('long password', storage)).toEqual(keys);
    deleteLocalKey(storage);
    expect(storage.getItem('worldbuilder.openai-vault.v1')).toBe('old-encrypted-record');
    expect(storage.getItem('worldbuilder.gemini-vault.v1')).toBe('old-encrypted-record-2');
  });
  it('rejects weak passphrases without replacing an existing record', async () => {
    const storage = memoryStorage();
    await saveLocalKey(keys, 'long password', storage);
    await expect(saveLocalKey(keys, 'weak', storage)).rejects.toThrow('8');
    expect(await unlockLocalKey('long password', storage)).toEqual(keys);
  });
});
