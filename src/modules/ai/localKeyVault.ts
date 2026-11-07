/** A passphrase-protected key vault tied to this browser origin, not a cloud sync. */
const STORAGE_KEY = 'worldbuilder.groq-tavily-vault.v1';
const ITERATIONS = 310000;
const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (value) => String.fromCharCode(value)).join(''));
}
function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
function subtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) throw new Error('التشفير غير متاح. افتح التطبيق عبر localhost في متصفح حديث.');
  return globalThis.crypto.subtle;
}
async function derive(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export function hasLocalKey(storage?: Storage): boolean {
  try { return (storage ?? globalThis.localStorage).getItem(STORAGE_KEY) !== null; }
  catch { throw new Error('تعذّر الوصول إلى تخزين المتصفح.'); }
}
export type ServiceKeys = { groq: string; tavily: string };
export async function saveLocalKey(apiKeys: ServiceKeys, passphrase: string, storage?: Storage): Promise<void> {
  const keys = { groq: apiKeys.groq.trim(), tavily: apiKeys.tavily.trim() };
  if (Object.values(keys).some((key) => key.length < 10 || key.length > 512)) throw new Error('أدخل مفتاحي Groq وTavily أولاً.');
  const key = JSON.stringify(keys);
  if (passphrase.length < 8) throw new Error('اختر كلمة مرور من 8 أحرف على الأقل.');
  subtle();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await subtle().encrypt({ name: 'AES-GCM', iv }, await derive(passphrase, salt), encoder.encode(key));
  try { (storage ?? globalThis.localStorage).setItem(STORAGE_KEY, JSON.stringify({ v: 1, salt: toBase64(salt), iv: toBase64(iv), data: toBase64(new Uint8Array(encrypted)) })); }
  catch { throw new Error('تعذّر الحفظ في هذا المتصفح. تحقّق من إعدادات التخزين.'); }
}
export async function unlockLocalKey(passphrase: string, storage?: Storage): Promise<ServiceKeys> {
  subtle();
  try {
    const value = (storage ?? globalThis.localStorage).getItem(STORAGE_KEY);
    if (!value) throw new Error('missing');
    const record = JSON.parse(value) as { v: number; salt: string; iv: string; data: string };
    if (record.v !== 1 || typeof record.salt !== 'string' || typeof record.iv !== 'string' || typeof record.data !== 'string' || record.data.length > 3000) throw new Error('invalid');
    const salt = fromBase64(record.salt), iv = fromBase64(record.iv), ciphertext = fromBase64(record.data);
    if (salt.length !== 16 || iv.length !== 12 || ciphertext.length < 17) throw new Error('invalid');
    const plaintext = await subtle().decrypt({ name: 'AES-GCM', iv }, await derive(passphrase, salt), ciphertext);
    const keys = JSON.parse(new TextDecoder().decode(plaintext)) as ServiceKeys;
    if (typeof keys.groq !== 'string' || typeof keys.tavily !== 'string' || !keys.groq || !keys.tavily) throw new Error('invalid');
    return { groq: keys.groq, tavily: keys.tavily };
  } catch { throw new Error('تعذّر فتح المفتاح. تأكّد من كلمة المرور ومن أن المفتاح محفوظ في هذا المتصفح.'); }
}
export function deleteLocalKey(storage?: Storage): void {
  try { (storage ?? globalThis.localStorage).removeItem(STORAGE_KEY); } catch { throw new Error('تعذّر حذف المفتاح من المتصفح.'); }
}
