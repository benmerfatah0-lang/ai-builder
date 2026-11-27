/**
 * Types for the interactive game map of «زعتر والحضيرة العظمى» — a cartoon
 * souls-like level-design map. Pure data: no Three.js dependency, so the same
 * definitions drive the 3D diorama, the minimap, the HUD and the offline
 * preview renderer.
 */

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export type RegionId = 'start' | 'farm' | 'crops' | 'pens' | 'final';
export type BossTier = 'required' | 'optional' | 'final';

export type LandmarkKind =
  | 'building'
  | 'npc'
  | 'item'
  | 'shortcut'
  | 'secret'
  | 'hazard'
  | 'gate'
  | 'summit';

export interface BossPhase {
  name: string;
  detail: string;
}

export interface BossDef {
  id: string;
  name: string;
  epithet: string;
  species: string;
  emoji: string;
  tier: BossTier;
  regionId: RegionId;
  position: Vec2;
  arenaId: string;
  level: string;
  difficulty: number;
  hp: string;
  quote: string;
  intro: string;
  phases: BossPhase[];
  arenaMechanics: string[];
  weaknesses: string[];
  rewards: string[];
  designNote: string;
}

/**
 * How a boss's home ground is staged.
 *
 * Each value is a *place that belongs to that animal*, not a generic ring: the
 * turkey fights in a threshing yard he has claimed, the duck on her pond, the
 * dog at his kennel. The old design put every boss on the same circular earth
 * plateau, which read as five copies of one arena.
 */
export type ArenaStyle =
  | 'threshing'
  | 'windmill'
  | 'ramring'
  | 'bridge'
  | 'yard'
  | 'palace'
  | 'farmhouse'
  | 'pond'
  | 'kennel';

export interface ArenaDef {
  id: string;
  name: string;
  position: Vec2;
  radius: number;
  style: ArenaStyle;
  regionId: RegionId;
  note: string;
  /** Yaw of the arena's own layout, so a building can face the approach. */
  rotation?: number;
  /**
   * The home ground's landmark: the building or water body the boss actually
   * lives in. Rendered by the arena builder, and clickable as part of the arena.
   */
  home?: {
    kind: 'house' | 'pond' | 'kennel' | 'threshing' | 'palace';
    /** Offset from `position`, in world units, along the arena's local +Z. */
    offset: Vec2;
    /** Yaw of the home itself, independent of the arena's own rotation. */
    rotation?: number;
  };
  /** Ground the fight happens on, when it is not bare earth. */
  floor?: 'earth' | 'boards' | 'straw' | 'grass' | 'water-edge';
}

export interface CheckpointDef {
  id: string;
  name: string;
  position: Vec2;
  note: string;
  unlocks?: string;
}

export interface LandmarkDef {
  id: string;
  name: string;
  kind: LandmarkKind;
  emoji: string;
  position: Vec2;
  regionId: RegionId;
  note: string;
  bossId?: string;
  /** Optional vertical offset of the label above the terrain. */
  height?: number;
}

export interface RegionDef {
  id: RegionId;
  kicker: string;
  name: string;
  shortName: string;
  emoji: string;
  color: string;
  deep: string;
  center: Vec2;
  radius: number;
  polygon: Vec2[];
  tagline: string;
  summary: string;
  mood: string;
  objectives: string[];
  beats: { title: string; detail: string }[];
  encounters: string[];
  hazards: string[];
  loot: string[];
  secrets: string[];
  bossIds: string[];
}

export type BuildingKind =
  | 'farmhouse'
  | 'barn'
  | 'silo'
  | 'shed'
  | 'stable'
  | 'market'
  | 'well'
  | 'tower'
  | 'windmill'
  | 'sheepShelter'
  | 'duckHouse'
  | 'nursery'
  | 'henPalace'
  | 'dogHouse'
  | 'threshingGranary'
  | 'gatehouse'
  | 'scarecrowShed';

export interface BuildingSpec {
  id: string;
  kind: BuildingKind;
  position: Vec2;
  rotation: number;
  scale?: number;
}

/**
 * Crop kinds.
 *
 * `maize` and `vine` are here because the reference map is built around them: a
 * golden cornfield and a trellised vineyard are two thirds of its fields, and the
 * old five kinds could not express either. Corn reuses the tall-row builder, vine
 * gets its own trellis posts.
 */
export type FieldKind = 'wheat' | 'vegetable' | 'clover' | 'sunflower' | 'pumpkin' | 'maize' | 'vine';

export interface FieldSpec {
  kind: FieldKind;
  x: number;
  z: number;
  w: number;
  d: number;
  rotation?: number;
  density?: number;
}

export type FenceStyle = 'rail' | 'stone' | 'bramble';

export interface FenceRun {
  id: string;
  points: Vec2[];
  style: FenceStyle;
  /** Optional gaps expressed as distances from the start of the polyline. */
  gaps?: { start: number; end: number }[];
}

export interface CircleFence {
  id: string;
  center: Vec2;
  radius: number;
  style: FenceStyle;
  gapStart: number;
  gapEnd: number;
}

export interface TreeZone {
  id: string;
  x: number;
  z: number;
  w: number;
  d: number;
  count: number;
  seed: number;
  mix: 'oak' | 'pine' | 'birch' | 'mixed';
}

export interface BridgeSpec {
  id: string;
  position: Vec2;
  rotation: number;
  length: number;
  width: number;
  style: 'plank' | 'stone';
}

export interface RouteStop {
  at: Vec2;
  label: string;
  kind: 'start' | 'checkpoint' | 'boss' | 'final';
}

export interface LegendItem {
  label: string;
  color: string;
  shape: 'dot' | 'ring' | 'diamond' | 'square' | 'flame';
}

export interface GuideSection {
  title: string;
  body: string;
}

export interface WorldWater {
  river: Vec2[];
  riverWidth: number;
  canal: Vec2[];
  canalWidth: number;
  pond: { x: number; z: number; r: number };
}
