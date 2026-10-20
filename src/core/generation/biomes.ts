import type { TimeOfDay, WorldScale } from '../../modules/ai/types';
import type { BiomeId } from '../../modules/ai/types';
import type { TerrainStyle } from '../world-plan/schema';

export interface BiomeProfile {
  id: BiomeId;
  label: string;
  terrainStyle: TerrainStyle;
  heightScale: number;
  palette: { low: string; high: string };
  sky: Record<TimeOfDay, string>;
  fogDensity: number;
  rockColor: string;
  buildingColors: { wall: string; roof: string };
}

export const BIOME_PROFILES: Record<BiomeId, BiomeProfile> = {
  meadow: {
    id: 'meadow',
    label: 'Meadow',
    terrainStyle: 'hills',
    heightScale: 6,
    palette: { low: '#5c7a45', high: '#9aad72' },
    sky: { day: '#8db8d9', sunset: '#e9a06c', night: '#0b1026' },
    fogDensity: 0.0022,
    rockColor: '#8a877c',
    buildingColors: { wall: '#b8a488', roof: '#7a4d3c' },
  },
  forest: {
    id: 'forest',
    label: 'Forest',
    terrainStyle: 'hills',
    heightScale: 8,
    palette: { low: '#3f5c36', high: '#71884d' },
    sky: { day: '#87b0cf', sunset: '#d99762', night: '#0a0f21' },
    fogDensity: 0.0034,
    rockColor: '#75786c',
    buildingColors: { wall: '#9c8a70', roof: '#5d4132' },
  },
  mountains: {
    id: 'mountains',
    label: 'Mountains',
    terrainStyle: 'mountains',
    heightScale: 24,
    palette: { low: '#5b625c', high: '#d4d8d4' },
    sky: { day: '#9cc3df', sunset: '#e3a17e', night: '#0d1226' },
    fogDensity: 0.0028,
    rockColor: '#84877f',
    buildingColors: { wall: '#a39b8b', roof: '#5b5e63' },
  },
  desert: {
    id: 'desert',
    label: 'Desert',
    terrainStyle: 'dunes',
    heightScale: 7,
    palette: { low: '#b58f5c', high: '#e2cb96' },
    sky: { day: '#b6d2de', sunset: '#f0a36a', night: '#0c1224' },
    fogDensity: 0.0014,
    rockColor: '#b08a63',
    buildingColors: { wall: '#c4a878', roof: '#8a6547' },
  },
  island: {
    id: 'island',
    label: 'Island',
    terrainStyle: 'islands',
    heightScale: 9,
    palette: { low: '#7e9164', high: '#c7bb8d' },
    sky: { day: '#8ad0e6', sunset: '#f2ab72', night: '#0a1222' },
    fogDensity: 0.0018,
    rockColor: '#8f8a78',
    buildingColors: { wall: '#c0a982', roof: '#8a5f45' },
  },
  ruins: {
    id: 'ruins',
    label: 'Ruins',
    terrainStyle: 'hills',
    heightScale: 7,
    palette: { low: '#64694a', high: '#9d9c76' },
    sky: { day: '#9fb7bf', sunset: '#dfa878', night: '#0b1020' },
    fogDensity: 0.003,
    rockColor: '#8b877a',
    buildingColors: { wall: '#8f8878', roof: '#6e6a5f' },
  },
};

export const SCALE_SETTINGS: Record<WorldScale, { size: number; resolution: number; countFactor: number }> = {
  small: { size: 96, resolution: 96, countFactor: 0.6 },
  medium: { size: 160, resolution: 128, countFactor: 1 },
  large: { size: 260, resolution: 160, countFactor: 1.7 },
};

/** Base object counts for a medium-sized world before explicit user counts. */
export const BASE_COUNTS: Record<
  BiomeId,
  { trees: number; rocks: number; buildings: number; lanterns: number }
> = {
  meadow: { trees: 16, rocks: 7, buildings: 0, lanterns: 0 },
  forest: { trees: 90, rocks: 12, buildings: 0, lanterns: 0 },
  mountains: { trees: 28, rocks: 24, buildings: 0, lanterns: 0 },
  desert: { trees: 8, rocks: 18, buildings: 0, lanterns: 0 },
  island: { trees: 22, rocks: 9, buildings: 0, lanterns: 0 },
  ruins: { trees: 10, rocks: 14, buildings: 5, lanterns: 3 },
};

export const SETTLEMENT_BUILDINGS = 14;
export const SETTLEMENT_LANTERNS = 8;
