import type { Transform, WorldEnvironment, Terrain, WorldPlan } from '../world-plan/schema';
import { WORLD_PLAN_SCHEMA_VERSION } from '../world-plan/schema';
import { createId, hashString } from '../utils/id';
import { mulberry32, intRange } from '../generation/rng';

export interface CreateWorldOptions {
  name?: string;
  seed?: number;
  description?: string;
}

export const DEFAULT_ENVIRONMENT: WorldEnvironment = {
  skyColor: '#8fb8d8',
  fogColor: '#adc6d6',
  fogDensity: 0.0022,
  sunColor: '#fff2dc',
  sunAzimuth: 220,
  sunElevation: 52,
  sunIntensity: 2.2,
  ambientIntensity: 0.55,
};

export const DEFAULT_TERRAIN: Terrain = {
  style: 'hills',
  size: 160,
  resolution: 128,
  heightScale: 9,
  waterLevel: null,
  palette: { low: '#597445', high: '#94a66d' },
};

function randomSeed(): number {
  return intRange(mulberry32((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0), 0, 0xffffffff);
}

export function createEmptyWorldPlan(options: CreateWorldOptions = {}): WorldPlan {
  const now = new Date().toISOString();
  const seed = options.seed ?? randomSeed();
  return {
    schemaVersion: WORLD_PLAN_SCHEMA_VERSION,
    id: createId('world'),
    name: options.name?.trim() || 'Untitled World',
    description: options.description ?? '',
    seed,
    createdAt: now,
    updatedAt: now,
    environment: { ...DEFAULT_ENVIRONMENT },
    terrain: {
      ...DEFAULT_TERRAIN,
      palette: { ...DEFAULT_TERRAIN.palette },
    },
    groups: [],
    objects: [],
  };
}

export function createTransform(position: [number, number, number] = [0, 0, 0]): Transform {
  return {
    position,
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };
}

/** Seed derived from prompt text so the same prompt reproduces the same world. */
export function seedFromPrompt(prompt: string): number {
  return hashString(prompt.trim().toLowerCase()) || 1234567;
}

export function touchWorld(plan: WorldPlan, now = new Date().toISOString()): WorldPlan {
  return { ...plan, updatedAt: now };
}

/** Object counts keyed by kind (`tree`, `building`, …) plus `total`. */
export function countObjects(plan: WorldPlan): Record<string, number> {
  const counts: Record<string, number> = { total: plan.objects.length };
  for (const object of plan.objects) {
    counts[object.kind] = (counts[object.kind] ?? 0) + 1;
  }
  return counts;
}
