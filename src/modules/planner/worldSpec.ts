import { z } from 'zod';
import type { BiomeId, TimeOfDay, WorldDensity, WorldScale, WorldStyle } from '../ai/types';
import type { PathStyle, TerrainStyle } from '../../core/world-plan/schema';
import type { RelationPredicate } from './frames';

/**
 * The structured World Specification.
 *
 * This is the planner's output contract: a complete, serializable description of
 * the world *before* anything is generated. It is deliberately a superset of
 * what today's generators consume — `WorldIntent` plus the parts the intent
 * cannot express (regions, relations, materials, weather, dependencies) — so the
 * existing generation systems can be driven from it unchanged.
 */

export const WORLD_SPEC_VERSION = 1;

/** Overall world dimensions in terrain units (schema bounds: 32..512). */
export interface WorldDimensions {
  size: number;
  resolution: number;
  scale: WorldScale;
  /** Explicit size words found in the description, kept for the report. */
  source: 'explicit' | 'scale-word' | 'default';
  /** Estimated playable area, for the report only. */
  areaUnitsSquared: number;
}

export interface LakeSpec {
  x: number;
  z: number;
  radius: number;
  depth: number;
}

export interface RiverSpec {
  /** Axis the ribbon follows, matching the existing decorative river builder. */
  axis: 'x' | 'z';
  width: number;
  /** True when the description asks the river to cross a named region. */
  throughRegion?: string;
  excavates: false;
}

export interface TerrainConfig {
  style: TerrainStyle;
  heightScale: number;
  roughness: number;
  waterLevel: number | null;
  water: boolean;
  lake?: LakeSpec;
  river?: RiverSpec;
  palette: { low: string; high: string };
  /** Landform words that were understood but not applied, for the report. */
  ignored?: string[];
}

/** How much of the world a biome covers, and where. */
export interface BiomeZone {
  id: string;
  biome: BiomeId;
  /** 0..1 share of the world; zones are normalized by the solver. */
  weight: number;
  region?: string;
  elevation?: 'low' | 'mid' | 'high';
  /** Compass/position selector, when the description named one. */
  selector?: RegionSelector;
}

export type RegionSelector = 'north' | 'south' | 'east' | 'west' | 'center' | 'edge' | 'summit' | 'base' | 'slope' | 'waterfront';

export type RegionShape = 'circle' | 'ring' | 'rect' | 'band' | 'whole';

export interface RegionSpec {
  id: string;
  name: string;
  shape: RegionShape;
  selector?: RegionSelector;
  center?: [number, number];
  radius?: number;
  biome?: BiomeId;
  landform?: TerrainStyle;
  density?: number;
  /** Mention ids that belong to this region. */
  members: string[];
}

export interface MaterialSpec {
  /** Named palette, e.g. `stone`, `clay`, `wood`. */
  palette?: string;
  wall?: string;
  roof?: string;
  trim?: string;
  roughness?: number;
  metalness?: number;
}

export type BuildingKind =
  | 'house' | 'castle' | 'tower' | 'watchtower' | 'ruin' | 'barn' | 'coop'
  | 'windmill' | 'lighthouse' | 'shrine' | 'gazebo' | 'market-stall' | 'tent'
  | 'well' | 'fountain' | 'stone-arch' | 'bridge' | 'mine-entrance' | 'column' | 'wall';

export interface BuildingSpec {
  id: string;
  kind: BuildingKind;
  /** Catalogue id used for realization; equals `kind` for offline assets. */
  assetId: string;
  count: number;
  label: string;
  architecture?: string;
  material?: MaterialSpec;
  size?: 'small' | 'large' | 'tall' | 'wide';
  region?: string;
  placement?: PlacementSpec;
  realized: 'procedural' | 'library' | 'unrealized';
}

export interface AssetSpec {
  id: string;
  assetId: string;
  label: string;
  count: number;
  category: 'vegetation' | 'prop' | 'structure' | 'rock' | 'water' | 'path';
  size?: 'small' | 'large' | 'tall' | 'wide';
  region?: string;
  material?: MaterialSpec;
  placement?: PlacementSpec;
  realized: 'procedural' | 'library' | 'unrealized';
}

/** Animals are named and counted; nothing local can build them yet. */
export interface AnimalSpec {
  id: string;
  count: number;
  label: string;
  region?: string;
  realized: 'unrealized' | 'library';
  notice: string;
}

/**
 * Lighting intent. The generator already derives physical light values from
 * `timeOfDay`; the planner only records *deltas* and explicit overrides so it
 * never duplicates (or contradicts) that table. The executor applies the deltas
 * to the generated environment, clamped to the schema ranges.
 */
export interface LightingSpec {
  timeOfDay: TimeOfDay;
  /** Multipliers applied to the generated values; 1 means "leave as generated". */
  sunIntensityScale: number;
  ambientIntensityScale: number;
  /** Absolute overrides, only when the description asked explicitly. */
  sunElevation?: number;
  sunAzimuth?: number;
  sunColor?: string;
  /** Cues the planner matched, for the interpretation report. */
  requested: string[];
}

export interface EnvironmentSpec {
  skyColor?: string;
  fogColor?: string;
  fogDensity?: number;
  weather: string[];
  season?: string;
  style?: WorldStyle;
  density?: WorldDensity;
  water: boolean;
}

/** How the planner intends to position something, before it is resolved. */
export interface PlacementSpec {
  strategy:
    | 'highest' | 'lowest' | 'ring' | 'scatter' | 'line' | 'water-edge'
    | 'region-center' | 'anchor-offset' | 'midpoint' | 'chain' | 'explicit';
  /** Region the placement belongs to. */
  region?: string;
  /** Anchor mention/asset id for relative strategies. */
  anchor?: string;
  /** Ring radius or line length, in terrain units. */
  radius?: number;
  /** Compass direction for anchor offsets. */
  direction?: 'left' | 'right' | 'front' | 'behind' | 'near';
  /** Resolved positions, filled in by the layout resolver. */
  positions?: [number, number][];
  /** Resolved polyline (roads, rivers, bridges), in terrain units. */
  polyline?: [number, number][];
  note?: string;
}

export interface SpatialRelation {
  id: string;
  predicate: RelationPredicate;
  /** Human-readable subject/anchor labels (Arabic when the input is Arabic). */
  subject: string;
  object: string;
  via?: string;
  second?: string;
  subjectId: string;
  objectId: string;
  /** Positions produced for this relation, once resolved. */
  resolved?: [number, number][];
  /** Polyline produced for connective relations (roads, rivers, bridges). */
  polyline?: [number, number][];
  status: 'pending' | 'resolved' | 'unsupported';
  note?: string;
}

export interface NegationSpec {
  target: string;
  label: string;
  applied: boolean;
}

export interface Clarification {
  id: string;
  severity: 'blocking' | 'advisory';
  question: string;
  options: { id: string; label: string }[];
  /** Chosen automatically when the user asks to continue with defaults. */
  defaultOption: string;
  reason: string;
}

/** One unit of work in the execution plan. */
export interface GenerationStep {
  id: string;
  title: string;
  producer:
    | 'validate' | 'terrain' | 'biomes' | 'regions' | 'landmarks' | 'buildings'
    | 'assets' | 'vegetation' | 'relations' | 'paths' | 'water' | 'materials'
    | 'lighting' | 'environment' | 'report';
  dependsOn: string[];
  /** What the step is allowed to spend. */
  budget: { objects: number };
  /** Filled in while executing. */
  status?: 'pending' | 'done' | 'skipped';
  detail?: string;
}

export interface ExecutionPlan {
  steps: GenerationStep[];
  /** Topological order of step ids; empty when the graph has a cycle. */
  order: string[];
  budgets: {
    maxObjects: number;
    reservedForRelations: number;
    estimatedObjects: number;
  };
  preflight: { ok: boolean; errors: string[]; warnings: string[] };
}

export interface WorldSpec {
  specVersion: typeof WORLD_SPEC_VERSION;
  prompt: string;
  name: string;
  seed: number;
  language: 'ar' | 'en' | 'mixed';
  dimensions: WorldDimensions;
  terrain: TerrainConfig;
  biomes: BiomeZone[];
  primaryBiome: BiomeId;
  regions: RegionSpec[];
  buildings: BuildingSpec[];
  assets: AssetSpec[];
  animals: AnimalSpec[];
  materials: MaterialSpec;
  lighting: LightingSpec;
  environment: EnvironmentSpec;
  relations: SpatialRelation[];
  /** Object positions keyed by building/asset id. */
  positions: Record<string, [number, number][]>;
  negations: NegationSpec[];
  counts: { trees: number; rocks: number; buildings: number; lanterns: number };
  clarifications: Clarification[];
  notices: string[];
  cues: string[];
  execution: ExecutionPlan;
  /** Which understanding tier produced this spec. */
  tier: 'rules' | 'rules+local-llm';
  offline: boolean;
}

// ── Validation of anything that arrives from outside the rule engine ─────────

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const positionPair = z.tuple([z.number().finite(), z.number().finite()]);

/**
 * Strict schema for local-LLM enrichment. A local model may only *add* hints;
 * it may never raise counts above the rule budget, delete a negation or invent
 * positions. Anything that fails validation is discarded and the deterministic
 * tier stays authoritative.
 */
export const llmEnrichmentSchema = z.object({
  language: z.enum(['ar', 'en', 'mixed']).optional(),
  name: z.string().min(1).max(80).optional(),
  biome: z.enum(['meadow', 'forest', 'mountains', 'desert', 'island', 'ruins']).optional(),
  landform: z.enum(['flat', 'hills', 'mountains', 'dunes', 'islands', 'valley', 'plateau', 'canyon', 'volcano', 'crater']).optional(),
  timeOfDay: z.enum(['day', 'sunset', 'night']).optional(),
  scale: z.enum(['small', 'medium', 'large']).optional(),
  density: z.enum(['sparse', 'normal', 'dense']).optional(),
  style: z.enum(['cartoon', 'natural', 'stylized']).optional(),
  weather: z.array(z.string().min(1).max(24)).max(6).optional(),
  architecture: z.array(z.string().min(1).max(24)).max(6).optional(),
  materials: z.object({
    palette: z.string().min(1).max(24).optional(),
    wall: hexColor.optional(),
    roof: hexColor.optional(),
  }).strict().optional(),
  regions: z.array(z.object({
    name: z.string().min(1).max(40),
    selector: z.enum(['north', 'south', 'east', 'west', 'center', 'edge', 'summit', 'base', 'slope', 'waterfront']),
    biome: z.enum(['meadow', 'forest', 'mountains', 'desert', 'island', 'ruins']).optional(),
  }).strict()).max(8).optional(),
  relations: z.array(z.object({
    subject: z.string().min(1).max(40),
    predicate: z.enum([
      'on-top-of', 'at-foot-of', 'inside', 'surrounding', 'surrounded-by', 'through',
      'across', 'near', 'between', 'connected-by', 'along', 'facing',
      'left-of', 'right-of', 'front-of', 'behind',
    ]),
    object: z.string().min(1).max(40),
  }).strict()).max(12).optional(),
  animals: z.array(z.object({ id: z.string().min(1).max(24), count: z.number().int().min(1).max(200) }).strict()).max(12).optional(),
  clarifications: z.array(z.string().min(1).max(200)).max(4).optional(),
  summary: z.string().min(1).max(400).optional(),
}).strict();

export type LlmEnrichment = z.infer<typeof llmEnrichmentSchema>;

/** Runtime guard for hand-authored or stored specs. */
export const worldSpecGuard = z.object({
  specVersion: z.literal(WORLD_SPEC_VERSION),
  seed: z.number().int().min(0).max(4294967295),
  dimensions: z.object({
    size: z.number().finite().min(32).max(512),
    resolution: z.number().int().min(16).max(256),
  }),
  terrain: z.object({
    style: z.string().min(1),
    waterLevel: z.number().finite().nullable(),
    lake: z.object({
      x: z.number().finite().min(-256).max(256),
      z: z.number().finite().min(-256).max(256),
      radius: z.number().finite().min(1).max(256),
      depth: z.number().finite().min(0.1).max(50),
    }).optional(),
  }),
  positions: z.record(z.string(), z.array(positionPair).max(400)),
}).passthrough();

/** Road surface implied by the requested materials and the terrain form. */
export function pathStyleFor(materials: MaterialSpec, terrainStyle: TerrainStyle | string): PathStyle {
  if (materials.palette === 'stone' || terrainStyle === 'mountains' || terrainStyle === 'canyon') return 'stone';
  if (terrainStyle === 'dunes') return 'gravel';
  return 'dirt';
}
