/** Small dependency-free ID helper with a non-crypto fallback for old webviews. */
export function createId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  return `${prefix}_${random}`;
}

/** FNV-1a 32-bit hash. Stable across browsers and used for deterministic seeds. */
export function hashString(input: string): number {
  let hash = 2166136261 >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function titleFromPrompt(prompt: string, maxLength = 48): string {
  const cleaned = prompt.replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'Untitled World';
  const words = cleaned.split(' ');
  let title = '';
  for (const word of words) {
    const candidate = title ? `${title} ${word}` : word;
    if (candidate.length > maxLength) break;
    title = candidate;
  }
  if (!title) title = cleaned.slice(0, maxLength);
  return title.charAt(0).toUpperCase() + title.slice(1);
}
