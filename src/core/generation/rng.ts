export interface Rng {
  (): number;
}

/** Mulberry32 — tiny, fast, seedable PRNG. Deterministic across platforms. */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function range(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

export function intRange(rng: Rng, min: number, max: number): number {
  return Math.floor(range(rng, min, max + 1));
}

export function chance(rng: Rng, probability: number): boolean {
  return rng() < probability;
}

export function pick<T>(rng: Rng, items: readonly T[], fallback: T): T {
  if (items.length === 0) return fallback;
  const index = Math.floor(rng() * items.length);
  return items[index] ?? fallback;
}

export function pickWeighted<T>(rng: Rng, items: readonly { value: T; weight: number }[]): T {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
  if (total <= 0 || items.length === 0) {
    throw new Error('pickWeighted requires at least one positively weighted item');
  }
  let threshold = rng() * total;
  for (const item of items) {
    threshold -= Math.max(0, item.weight);
    if (threshold <= 0) return item.value;
  }
  const last = items[items.length - 1];
  if (!last) throw new Error('pickWeighted failed');
  return last.value;
}
