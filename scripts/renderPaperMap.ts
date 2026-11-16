/**
 * Generates `src/game-map/ui/paperMap.svg.ts` — the hand-drawn paper map used
 * in the map app's «الخريطة الورقية» tab.
 *
 * The art is authored here (not in the browser) and inlined as a TS string so
 * the app ships a single-file, offline map that matches the 3D diorama data.
 * Re-run after changing map geometry:
 *
 *   npx tsx scripts/renderPaperMap.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ARENAS,
  BOSSES,
  BRIDGES,
  BUILDINGS,
  CHECKPOINTS,
  CIRCLE_FENCES,
  FENCES,
  FIELDS,
  LANDMARKS,
  REGIONS,
  ROADS,
  TREES,
  WATER,
  WORLD,
} from '../src/game-map/data';

const W = 1000;
// Header band reserves space for the title cartouche so it never covers the
// palace region at the map's northern edge.
const HEADER = 112;
const MAP_W = 1000;
const MAP_H = 1202;
const H = HEADER + MAP_H + 44;
const PAD = 38;

const sx = (value: number) => PAD + ((value - WORLD.minX) / (WORLD.maxX - WORLD.minX)) * (MAP_W - PAD * 2);
const sz = (value: number) => HEADER + PAD + ((value - WORLD.minZ) / (WORLD.maxZ - WORLD.minZ)) * (MAP_H - PAD * 2);

const n = (value: number) => Math.round(value * 10) / 10;
const pt = ([x, z]: [number, number]) => `${n(sx(x))},${n(sz(z))}`;

const REGION_FILL: Record<string, string> = {
  start: '#cfe0bb',
  farm: '#f0d7ab',
  crops: '#f2e2a6',
  pens: '#dfe4bd',
  final: '#eccfa9',
};

const ROAD_KIND: Record<string, 'main' | 'lane' | 'trail'> = {
  'main-avenue': 'main',
  'palace-court': 'main',
};

const parts: string[] = [];

/* ---------------------------------------------------------------- defs */
parts.push(`<defs>
  <radialGradient id="paperSheen" cx="50%" cy="38%" r="75%">
    <stop offset="0%" stop-color="#f8f0da"/>
    <stop offset="70%" stop-color="#eee0bd"/>
    <stop offset="100%" stop-color="#dfcda3"/>
  </radialGradient>
  <linearGradient id="waterFill" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#9ecbdb"/>
    <stop offset="100%" stop-color="#7fb4c9"/>
  </linearGradient>
  <pattern id="grid" width="44" height="44" patternUnits="userSpaceOnUse">
    <path d="M44 0 L0 0 0 44" fill="none" stroke="#c8b78f" stroke-width="0.6" opacity="0.5"/>
  </pattern>
  <pattern id="wheat-hatch" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
    <line x1="0" y1="0" x2="0" y2="9" stroke="#c9a23e" stroke-width="1.4" opacity="0.7"/>
  </pattern>
  <pattern id="veg-hatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)">
    <line x1="0" y1="0" x2="0" y2="10" stroke="#7f9f4a" stroke-width="1.3" opacity="0.65"/>
  </pattern>
  <pattern id="orchard-dots" width="26" height="26" patternUnits="userSpaceOnUse">
    <circle cx="7" cy="8" r="3.4" fill="#7fa45c" opacity="0.55"/>
    <circle cx="19" cy="19" r="3" fill="#6f9450" opacity="0.45"/>
  </pattern>
  <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
    <feDropShadow dx="0" dy="2.4" stdDeviation="2.2" flood-color="#5a4326" flood-opacity="0.35"/>
  </filter>
</defs>`);

/* ------------------------------------------------------------- base sheet */
parts.push(`<rect width="${W}" height="${H}" fill="url(#paperSheen)"/>`);
parts.push(`<rect width="${W}" height="${H}" fill="url(#grid)"/>`);
// Stylised contour ticks around the rim.
for (let index = 0; index < 34; index += 1) {
  const t = index / 34;
  const angle = t * Math.PI * 2;
  const rx = 468;
  const ry = (MAP_H - PAD * 2) / 2 + 4;
  const cx = MAP_W / 2;
  const cy = HEADER + MAP_H / 2;
  const x1 = cx + Math.cos(angle) * rx;
  const y1 = cy + Math.sin(angle) * ry;
  const x2 = cx + Math.cos(angle) * (rx + 12);
  const y2 = cy + Math.sin(angle) * (ry + 12);
  parts.push(`<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="#b9a77f" stroke-width="2" opacity="0.5"/>`);
}

/* -------------------------------------------------------------- regions */
for (const region of REGIONS) {
  const points = region.polygon.map(pt).join(' ');
  parts.push(
    `<polygon points="${points}" fill="${REGION_FILL[region.id]}" stroke="${region.color}" stroke-width="3.4" stroke-dasharray="11 7" opacity="0.7"/>`,
  );
}

/* ----------------------------------------------------------------- water */
const riverPoints = WATER.river.map(pt).join(' ');
parts.push(`<polyline points="${riverPoints}" fill="none" stroke="#9fc7d5" stroke-width="44" stroke-linejoin="round" opacity="0.7"/>`);
parts.push(`<polyline points="${riverPoints}" fill="none" stroke="url(#waterFill)" stroke-width="30" stroke-linejoin="round"/>`);
parts.push(
  `<polyline points="${WATER.canal.map(pt).join(' ')}" fill="none" stroke="url(#waterFill)" stroke-width="12" stroke-linejoin="round" opacity="0.9"/>`,
);
parts.push(
  `<circle cx="${n(sx(WATER.pond.x))}" cy="${n(sz(WATER.pond.z))}" r="${n(((WATER.pond.r * 2) / (WORLD.maxX - WORLD.minX)) * (W - PAD * 2) / 2)}" fill="url(#waterFill)" stroke="#86a9b8" stroke-width="2"/>`,
);
// Water ripples.
parts.push(
  `<g stroke="#ffffff" stroke-width="2" opacity="0.65">
    <path d="M ${n(sx(-60))} ${n(sz(-82))} q 14 -7 28 0 q 14 7 28 0" fill="none"/>
    <path d="M ${n(sx(42))} ${n(sz(-84))} q 14 -7 28 0 q 14 7 28 0" fill="none"/>
  </g>`,
);
// Bridge.
for (const bridge of BRIDGES) {
  const x = sx(bridge.position[0]);
  const z = sz(bridge.position[1]);
  const w = ((bridge.width / (WORLD.maxX - WORLD.minX)) * (W - PAD * 2));
  const h = ((bridge.length / (WORLD.maxZ - WORLD.minZ)) * (H - PAD * 2));
  parts.push(
    `<g filter="url(#softShadow)"><rect x="${n(x - (bridge.rotation === 0 ? w / 2 : h / 2))}" y="${n(z - (bridge.rotation === 0 ? h / 2 : w / 2))}" width="${n(bridge.rotation === 0 ? w : h)}" height="${n(bridge.rotation === 0 ? h : w)}" rx="4" fill="#b98a52" stroke="#7d572f" stroke-width="2"/></g>`,
  );
}

/* ------------------------------------------------------------------ trees */
for (const zone of TREES) {
  const x = sx(zone.x);
  const y = sz(zone.z);
  const w = (zone.w / (WORLD.maxX - WORLD.minX)) * (W - PAD * 2);
  const h = (zone.d / (WORLD.maxZ - WORLD.minZ)) * (H - PAD * 2);
  parts.push(
    `<rect x="${n(x - w / 2)}" y="${n(y - h / 2)}" width="${n(w)}" height="${n(h)}" rx="14" fill="url(#orchard-dots)" opacity="0.9"/>`,
  );
  // A few tree glyphs for a drawn feel.
  const count = zone.id === 'start-wood' || zone.id === 'fox-den' ? 6 : 4;
  for (let index = 0; index < count; index += 1) {
    const tx = x + ((index % 3) / 2 - 0.5) * w * 0.8;
    const ty = y + (Math.floor(index / 3) / 1.5 - 0.3) * h * 0.8;
    parts.push(treeGlyph(tx, ty, 0.8 + (index % 3) * 0.18));
  }
}

function treeGlyph(x: number, y: number, scale: number) {
  return `<g transform="translate(${n(x)} ${n(y)}) scale(${scale})" opacity="0.85">
    <circle cx="0" cy="-6" r="7.5" fill="#6f9c57" stroke="#4f7440" stroke-width="1.4"/>
    <circle cx="6" cy="-2" r="5.5" fill="#7fae64" stroke="#4f7440" stroke-width="1.2"/>
    <circle cx="-6" cy="-1" r="5" fill="#78a75e" stroke="#4f7440" stroke-width="1.2"/>
    <line x1="0" y1="1" x2="0" y2="9" stroke="#7a5734" stroke-width="2"/>
  </g>`;
}

/* ----------------------------------------------------------------- fields */
function fieldMotif(kind: string, cx: number, cy: number, w: number, h: number) {
  const marks: string[] = [];
  if (kind === 'wheat') {
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 4; col += 1) {
        const x = cx - w * 0.32 + (col / 3) * w * 0.64;
        const y = cy - h * 0.24 + (row / 2) * h * 0.48;
        marks.push(`<path d="M ${n(x)} ${n(y + 6)} L ${n(x)} ${n(y - 4)} M ${n(x)} ${n(y - 4)} l -3 4 M ${n(x)} ${n(y - 4)} l 3 4" stroke="#a9822f" stroke-width="1.6" fill="none"/>`);
      }
    }
  } else if (kind === 'sunflower') {
    for (let index = 0; index < 5; index += 1) {
      const x = cx + ((index % 3) - 1) * w * 0.24;
      const y = cy + (Math.floor(index / 3) - 0.5) * h * 0.3;
      marks.push(`<circle cx="${n(x)}" cy="${n(y)}" r="5" fill="#e8b93c" stroke="#a1741f" stroke-width="1.2"/><circle cx="${n(x)}" cy="${n(y)}" r="2" fill="#7d5313"/>`);
    }
  } else if (kind === 'pumpkin') {
    for (let index = 0; index < 6; index += 1) {
      const x = cx + ((index % 3) - 1) * w * 0.26;
      const y = cy + (Math.floor(index / 3) - 0.5) * h * 0.32;
      marks.push(`<circle cx="${n(x)}" cy="${n(y)}" r="4.6" fill="#e08a3c" stroke="#9c5a22" stroke-width="1.2"/>`);
    }
  } else {
    for (let index = 0; index < 6; index += 1) {
      const x = cx + ((index % 3) - 1) * w * 0.26;
      const y = cy + (Math.floor(index / 3) - 0.5) * h * 0.32;
      marks.push(`<path d="M ${n(x - 4)} ${n(y)} q 4 -5 8 0 q -4 5 -8 0 Z" fill="#6f9a4a" stroke="#44682c" stroke-width="1.1"/>`);
    }
  }
  return marks.join('');
}

for (const field of FIELDS) {
  const x = sx(field.x - field.w / 2);
  const y = sz(field.z - field.d / 2);
  const w = (field.w / (WORLD.maxX - WORLD.minX)) * (W - PAD * 2);
  const h = (field.d / (WORLD.maxZ - WORLD.minZ)) * (H - PAD * 2);
  const fill = field.kind === 'wheat' || field.kind === 'sunflower' ? 'url(#wheat-hatch)' : field.kind === 'pumpkin' ? '#f0cfae' : 'url(#veg-hatch)';
  parts.push(
    `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="3" fill="#d9c7a2" stroke="#9a7a4c" stroke-width="1.8"/>`,
  );
  parts.push(`<rect x="${n(x + 3)}" y="${n(y + 3)}" width="${n(w - 6)}" height="${n(h - 6)}" rx="2" fill="${fill}" opacity="0.9"/>`);
  parts.push(fieldMotif(field.kind, x + w / 2, y + h / 2, w, h));
}

/* ----------------------------------------------------------------- fences */
for (const fence of FENCES) {
  const d = fence.points.map(pt).join(' ');
  parts.push(
    `<polyline points="${d}" fill="none" stroke="#8a6540" stroke-width="${fence.style === 'stone' ? 3.4 : 2.2}" stroke-dasharray="${fence.style === 'bramble' ? '2 5' : '7 5'}" stroke-linecap="round" opacity="0.85"/>`,
  );
}
for (const circle of CIRCLE_FENCES) {
  const r = ((circle.radius * (W - PAD * 2)) / (WORLD.maxX - WORLD.minX));
  parts.push(
    `<circle cx="${n(sx(circle.center[0]))}" cy="${n(sz(circle.center[1]))}" r="${n(r)}" fill="none" stroke="#8a6540" stroke-width="2.4" stroke-dasharray="8 6" opacity="0.9"/>`,
  );
}

/* ------------------------------------------------------------------ roads */
for (const road of ROADS) {
  const kind = ROAD_KIND[road.id] ?? (road.width > 2.6 ? 'lane' : 'trail');
  const width = kind === 'main' ? 15 : kind === 'lane' ? 9 : 6.5;
  const d = `M ${road.points.map(([x, z]) => `${n(sx(x))} ${n(sz(z))}`).join(' L ')}`;
  parts.push(`<path d="${d}" fill="none" stroke="#a9855a" stroke-width="${width + 4}" stroke-linecap="round" stroke-linejoin="round" opacity="0.55"/>`);
  parts.push(`<path d="${d}" fill="none" stroke="#f8ecd0" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${kind === 'trail' ? '1 8' : 'none'}"/>`);
}

/* -------------------------------------------------------------- buildings */
function buildingGlyph(kind: string, scale: number) {
  const roof = kind === 'barn' ? '#8f4236' : kind === 'henPalace' ? '#3e2430' : kind === 'windmill' ? '#b8563d' : '#b8563d';
  const wall = kind === 'barn' ? '#f0dcc0' : kind === 'silo' ? '#e6dccb' : '#e8d6b2';
  const body = `<rect x="${-13 * scale}" y="${-4 * scale}" width="${26 * scale}" height="${14 * scale}" fill="${wall}" stroke="#6d4f30" stroke-width="2"/>`;
  const gable = `<path d="M ${-16 * scale} ${-4 * scale} L 0 ${-15 * scale} L ${16 * scale} ${-4 * scale} Z" fill="${roof}" stroke="#6d3a26" stroke-width="2"/>`;
  if (kind === 'silo') {
    return `<g><rect x="${-7 * scale}" y="${-14 * scale}" width="${14 * scale}" height="${26 * scale}" fill="${wall}" stroke="#6d4f30" stroke-width="2"/><path d="M ${-7 * scale} ${-14 * scale} Q 0 ${-22 * scale} ${7 * scale} ${-14 * scale}" fill="#8b8f92" stroke="#6d4f30" stroke-width="2"/></g>`;
  }
  if (kind === 'windmill') {
    return `<g>${body}${gable}<g stroke="#8a6a45" stroke-width="2"><line x1="0" y1="${-10 * scale}" x2="-11*${scale}" y2="-24*${scale}"/><line x1="0" y1="${-10 * scale}" x2="11*${scale}" y2="-24*${scale}"/><line x1="0" y1="${-10 * scale}" x2="-11*${scale}" y2="${4 * scale}"/><line x1="0" y1="${-10 * scale}" x2="11*${scale}" y2="${4 * scale}"/></g><circle cx="0" cy="${-10 * scale}" r="2.4" fill="#5d3d22"/></g>`;
  }
  if (kind === 'henPalace') {
    return `<g>${body}${gable}<rect x="${-13 * scale}" y="${-20 * scale}" width="${26 * scale}" height="4" fill="#f0cf8a" stroke="#8a6d42" stroke-width="1.4"/><circle cx="0" cy="${-23 * scale}" r="${4 * scale}" fill="none" stroke="#d9a72e" stroke-width="2"/></g>`;
  }
  if (kind === 'well') {
    return `<g><circle r="${9 * scale}" fill="#cfc6ad" stroke="#6d4f30" stroke-width="2"/><circle r="${4.5 * scale}" fill="#7fb4c9"/><path d="M ${-9 * scale} -2 L 0 ${-12 * scale} L ${9 * scale} -2" fill="none" stroke="#b8563d" stroke-width="3"/></g>`;
  }
  return `<g>${body}${gable}</g>`;
}

for (const building of BUILDINGS) {
  const scale = (building.scale ?? 1) * 0.86;
  const x = sx(building.position[0]);
  const y = sz(building.position[1]);
  parts.push(
    `<g transform="translate(${n(x)} ${n(y)}) rotate(${n((-building.rotation * 180) / Math.PI)})" filter="url(#softShadow)">${buildingGlyph(building.kind, scale)}</g>`,
  );
}

/* ----------------------------------------------------------------- arenas */
for (const arena of ARENAS) {
  const boss = BOSSES.find((entry) => entry.arenaId === arena.id);
  const r = (arena.radius / (WORLD.maxX - WORLD.minX)) * (W - PAD * 2);
  const color = boss?.tier === 'optional' ? '#8a5bb0' : boss?.tier === 'final' ? '#b8860b' : '#a33b2e';
  parts.push(
    `<circle cx="${n(sx(arena.position[0]))}" cy="${n(sz(arena.position[1]))}" r="${n(r)}" fill="#d7bd90" fill-opacity="0.55" stroke="${color}" stroke-width="2.6" stroke-dasharray="9 5"/>`,
  );
}

/* ------------------------------------------------------------- checkpoints */
for (const checkpoint of CHECKPOINTS) {
  parts.push(campfireGlyph(sx(checkpoint.position[0]), sz(checkpoint.position[1])));
}
function campfireGlyph(x: number, y: number) {
  return `<g transform="translate(${n(x)} ${n(y)})">
    <circle r="13" fill="#fff1c4" opacity="0.55"/>
    <path d="M 0 -9 C 5 -3 7 1 4 5 C 2 8 -2 8 -4 5 C -7 1 -5 -3 0 -9 Z" fill="#ea8a3a" stroke="#a34e1d" stroke-width="1.4"/>
    <path d="M 0 -3 C 2 0 3 2 1 4 C 0 5 -1 4 -1 3 C -2 1 0 0 0 -3 Z" fill="#ffd166"/>
  </g>`;
}

/* ------------------------------------------------------------------- NPCs */
function npcGlyph(x: number, y: number, kind: string) {
  const bubble = `<circle r="13" fill="#6fb6ff" stroke="#2c5f96" stroke-width="2"/>`;
  const inner: Record<string, string> = {
    snail: `<circle cx="-3" cy="2" r="5" fill="#e8d6b2" stroke="#7d5313" stroke-width="1.6"/><path d="M -3 -3 Q 3 -1 2 3" fill="none" stroke="#7d5313" stroke-width="1.6"/><line x1="3" y1="6" x2="10" y2="8" stroke="#7d5313" stroke-width="2"/>`,
    crow: `<path d="M -7 3 Q -2 -6 4 -2 Q 8 0 7 4 L 2 6 L -3 8 Z" fill="#2f2a2e"/><circle cx="4" cy="-2" r="2.6" fill="#2f2a2e"/><path d="M 6 -2 L 10 -1 L 6 0 Z" fill="#d9a72e"/>`,
    goat: `<path d="M -6 6 L -6 0 Q -6 -5 0 -5 Q 6 -5 6 0 L 6 6" fill="#f4ecd8" stroke="#6d4f30" stroke-width="1.6"/><path d="M -3 -5 Q -6 -10 -2 -10 M 3 -5 Q 6 -10 2 -10" fill="none" stroke="#8a6a45" stroke-width="2"/>`,
    scarecrow: `<line x1="0" y1="-9" x2="0" y2="9" stroke="#8a6a45" stroke-width="2"/><line x1="-8" y1="-2" x2="8" y2="-2" stroke="#8a6a45" stroke-width="2"/><circle cy="-6" r="4" fill="#e2c268" stroke="#7d5313" stroke-width="1.4"/><path d="M -7 -10 L 7 -10" stroke="#b8860b" stroke-width="2"/>`,
    worm: `<path d="M -7 4 Q -3 -6 1 0 Q 4 6 8 1" fill="none" stroke="#c98a8a" stroke-width="4" stroke-linecap="round"/>`,
    dog: `<path d="M -7 4 Q -6 -4 0 -4 Q 6 -4 7 2 L 4 6 L -2 6 Z" fill="#c9a06a" stroke="#6d4f30" stroke-width="1.4"/><circle cx="5" cy="-1" r="1" fill="#3a2a20"/>`,
    hen: `<circle cx="0" cy="2" r="5.5" fill="#f6eedd" stroke="#7d6b52" stroke-width="1.4"/><circle cx="4" cy="-3" r="3" fill="#f6eedd" stroke="#7d6b52" stroke-width="1.2"/><path d="M 3 -7 Q 4 -10 6 -7" fill="none" stroke="#c1503d" stroke-width="2"/>`,
  };
  return `<g transform="translate(${n(x)} ${n(y)})">${bubble}${inner[kind] ?? ''}</g>`;
}

for (const landmark of LANDMARKS) {
  const x = sx(landmark.position[0]);
  const y = sz(landmark.position[1]);
  if (landmark.kind === 'npc') {
    parts.push(npcGlyph(x, y, landmark.id));
  } else if (landmark.kind === 'secret') {
    parts.push(`<g transform="translate(${n(x)} ${n(y)}) rotate(45)">
      <rect x="-8" y="-8" width="16" height="16" rx="2" fill="#c98a2c" stroke="#7d5313" stroke-width="2"/>
      <circle r="2.6" fill="#fff4dd"/>
    </g>`);
  } else if (landmark.kind === 'shortcut') {
    parts.push(`<g transform="translate(${n(x)} ${n(y)})">
      <rect x="-9" y="-9" width="18" height="18" rx="3" fill="#6bd6a8" stroke="#2c7a58" stroke-width="2"/>
      <path d="M -4 0 L 4 0 M 1 -3 L 4 0 L 1 3" stroke="#154232" stroke-width="2" fill="none"/>
    </g>`);
  }
}

/* ------------------------------------------------------------- boss badges */
function bossGlyph(boss: (typeof BOSSES)[number]) {
  const white = '#fff8ea';
  const dark = '#3a2718';
  switch (boss.id) {
    case 'grobak': // turkey with a fanned tail
      return `<g stroke="${white}" stroke-width="1.6" fill="none">
        <circle cx="0" cy="1" r="5.4" fill="${white}"/>
        <path d="M -8 -3 L -3 4 M 8 -3 L 3 4 M -6 -7 L 0 2 M 6 -7 L 0 2" />
        <path d="M 0 -5 L 0 -11" stroke="${dark}"/>
        <circle cx="0" cy="-12" r="2.2" fill="${dark}" stroke="none"/>
      </g>`;
    case 'squawk': // rooster: crest + beak
      return `<g stroke="${white}" stroke-width="1.6" fill="none">
        <circle cx="0" cy="1" r="5.2" fill="${white}"/>
        <path d="M -2 -7 L 0 -11 L 2 -7 M 2 -6 L 4 -10 L 5 -5" fill="${dark}" stroke="${dark}"/>
        <path d="M 5 0 L 9 1 L 5 3 Z" fill="${dark}" stroke="none"/>
        <path d="M -6 2 Q -10 4 -8 7" stroke="${dark}"/>
      </g>`;
    case 'quackmire': // duck bill
      return `<g stroke="${white}" stroke-width="1.6" fill="none">
        <circle cx="0" cy="1" r="5.4" fill="${white}"/>
        <path d="M 4 -1 L 11 0 L 4 3 Z" fill="${dark}" stroke="${dark}"/>
        <circle cx="2" cy="-2" r="0.9" fill="${dark}" stroke="none"/>
      </g>`;
    case 'bristleback': // ram horns
      return `<g stroke="${white}" stroke-width="1.6" fill="none">
        <circle cx="0" cy="1" r="5.2" fill="${white}"/>
        <path d="M -4 -4 C -10 -6 -10 -12 -5 -11 C -2 -10 -3 -6 -5 -7" />
        <path d="M 4 -4 C 10 -6 10 -12 5 -11 C 2 -10 3 -6 5 -7" />
        <circle cx="-2" cy="1" r="0.9" fill="${dark}" stroke="none"/>
        <circle cx="2" cy="1" r="0.9" fill="${dark}" stroke="none"/>
      </g>`;
    default: // queen hen with crown
      return `<g stroke="${white}" stroke-width="1.6" fill="none">
        <circle cx="0" cy="2" r="5.6" fill="${white}"/>
        <path d="M -4 -5 L -5 -10 L -1 -7 L 1 -11 L 3 -7 L 6 -10 L 5 -5 Z" fill="#ffd54a" stroke="#8a6414"/>
        <path d="M 5 1 L 9 2 L 5 4 Z" fill="${dark}" stroke="${dark}"/>
        <circle cx="2" cy="-1" r="0.9" fill="${dark}" stroke="none"/>
      </g>`;
  }
}

for (const boss of BOSSES) {
  const x = sx(boss.position[0]);
  const y = sz(boss.position[1]);
  const color = boss.tier === 'optional' ? '#8a5bb0' : boss.tier === 'final' ? '#b8860b' : '#a33b2e';
  parts.push(`<g transform="translate(${n(x)} ${n(y)})" filter="url(#softShadow)">
    <circle r="20" fill="${color}" stroke="#fff3d6" stroke-width="3.5"/>
    ${bossGlyph(boss)}
  </g>`);
  const namePos: Record<string, [number, number]> = {
    grobak: [22, 46],
    squawk: [0, 50],
    quackmire: [-58, 12],
    bristleback: [0, 50],
    cluckzilla: [0, -34],
  };
  const [dx, dy] = namePos[boss.id] ?? [0, 38];
  parts.push(`<text x="${n(x + dx)}" y="${n(y + dy)}" class="boss-name">${boss.name}</text>`);
}

/* ------------------------------------------------------------------- route */
const route: [number, number][] = [
  [0, 148], [-6, 138], [0, 118], [2, 66], [-26, 44], [0, 20], [2, -10],
  [10, -60], [10, -80], [14, -96], [44, -98], [-44, -100], [-46, -124],
];
const routePath = route.map(pt).join(' ');
parts.push(`<polyline points="${routePath}" fill="none" stroke="#fff3d6" stroke-width="7" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>`);
parts.push(`<polyline points="${routePath}" fill="none" stroke="#d9761f" stroke-width="3.6" stroke-dasharray="11 7" stroke-linejoin="round" stroke-linecap="round"/>`);
parts.push(`<g transform="translate(${n(sx(0))} ${n(sz(150))})">
  <circle r="16" fill="#2b2118" stroke="#ffd166" stroke-width="3"/>
  <text y="7" class="start-icon">🦊</text>
</g>`);

/* ---------------------------------------------------------- region key band */
{
  const chips = REGIONS.map((region) => `${region.name}`);
  const chipWidth = 152;
  const total = chips.length * chipWidth;
  const startX = W / 2 - total / 2;
  parts.push(`<g filter="url(#softShadow)">
    <rect x="${n(startX - 16)}" y="${HEADER + 6}" width="${total + 32}" height="40" rx="10" fill="#f6ead0" stroke="#a98a5c" stroke-width="1.8" opacity="0.96"/>`);
  REGIONS.forEach((region, index) => {
    const x = startX + index * chipWidth + chipWidth / 2;
    parts.push(`<g transform="translate(${n(x)} ${HEADER + 30})">
      <rect x="-9" y="-9" width="18" height="18" rx="4" fill="${region.color}" stroke="#5d4326" stroke-width="1.2"/>
      <text x="14" y="7" class="region-chip">${region.name}</text>
    </g>`);
  });
  parts.push(`</g>`);
}

/* ---------------------------------------------- decorative cartouche/frame */
parts.push(`<rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="18" fill="none" stroke="#8a6d42" stroke-width="4"/>`);
parts.push(`<rect x="16" y="16" width="${W - 32}" height="${H - 32}" rx="14" fill="none" stroke="#b59a6a" stroke-width="1.6" stroke-dasharray="3 5"/>`);
parts.push(`<line x1="34" y1="${HEADER - 4}" x2="${W - 34}" y2="${HEADER - 4}" stroke="#b59a6a" stroke-width="1.6" stroke-dasharray="2 6"/>`);

// Title cartouche in the reserved header band.
parts.push(`<g filter="url(#softShadow)">
  <rect x="${W / 2 - 268}" y="16" width="536" height="82" rx="13" fill="#2b2118" opacity="0.94" stroke="#f0b552" stroke-width="2.5"/>
  <text x="${W / 2}" y="56" class="map-title">زعتر والحضيرة العظمى</text>
  <text x="${W / 2}" y="86" class="map-subtitle">مزرعة · زراعة · حظائر — خريطة المستويات</text>
</g>`);

// Compass rose.
parts.push(`<g transform="translate(${W - 84} ${H - 108})">
  <circle r="44" fill="#f4e9cd" stroke="#8a6d42" stroke-width="2.4"/>
  <circle r="34" fill="none" stroke="#b59a6a" stroke-width="1.2"/>
  <path d="M 0 -34 L 9 0 L 0 34 L -9 0 Z" fill="#8a4a2a"/>
  <path d="M 0 -34 L 0 34 L -9 0 Z" fill="#b98a52"/>
  <text y="-48" class="compass-n">ش</text>
  <text y="56" class="compass-sm">ج</text>
  <text x="52" y="6" class="compass-sm">ق</text>
  <text x="-52" y="6" class="compass-sm">غ</text>
</g>`);

// Legend box.
const legendItems = [
  ['#a33b2e', 'بوس رئيسي'],
  ['#8a5bb0', 'بوس اختياري'],
  ['#b8860b', 'البوس النهائي'],
  ['#f0b552', 'نقطة حفظ'],
  ['#6fb6ff', 'شخصية'],
  ['#6bd6a8', 'اختصار'],
  ['#c98a2c', 'سرّ'],
];
parts.push(`<g filter="url(#softShadow)">
  <rect x="30" y="${H - 286}" width="252" height="224" rx="12" fill="#2b2118" opacity="0.92" stroke="#8a6d42" stroke-width="2"/>
  <text x="156" y="${H - 258}" class="legend-title">مفتاح الخريطة</text>
  ${legendItems
    .map(
      ([color, name], index) => `<g transform="translate(58 ${H - 232 + index * 26})">
        <circle r="7" fill="${color}" stroke="#f3e6c8" stroke-width="1"/>
        <text x="16" y="6" class="legend-text" text-anchor="start">${name}</text>
      </g>`,
    )
    .join('')}
</g>`);

// Footer note.
parts.push(
  `<text x="${W / 2}" y="${H - 26}" class="map-footnote">الاتجاه: الأعلى شمالًا (المزرعة) · المقاس تقريبي · الخط المتقطّع = مسار زعتر المقترح</text>`,
);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="'Noto Naskh Arabic', 'Amiri', serif">
<style>
  .region-name { font-size: 30px; font-weight: 700; text-anchor: middle; font-family: 'Noto Naskh Arabic', 'Amiri', serif; paint-order: stroke; stroke: #f7ecd4; stroke-width: 6px; }
  .field-icon { font-size: 18px; text-anchor: middle; }
  .building-icon { font-size: 15px; text-anchor: middle; }
  .npc-icon { font-size: 12px; text-anchor: middle; }
  .boss-badge { font-size: 20px; text-anchor: middle; }
  .boss-name { font-size: 21px; font-weight: 700; text-anchor: middle; fill: #4a3018; paint-order: stroke; stroke: #f3e6c8; stroke-width: 4px; }
  .start-icon { font-size: 17px; text-anchor: middle; }
  .map-title { font-size: 42px; font-weight: 700; text-anchor: middle; fill: #ffd987; }
  .map-subtitle { font-size: 22px; text-anchor: middle; fill: #e2cba4; }
  .compass-n { font-size: 22px; font-weight: 700; text-anchor: middle; fill: #6d4a22; }
  .compass-sm { font-size: 16px; text-anchor: middle; fill: #8a6d42; }
  .legend-title { font-size: 22px; font-weight: 700; text-anchor: middle; fill: #ffd987; }
  .legend-text { font-size: 16px; fill: #efe0c4; }
  .map-footnote { font-size: 18px; text-anchor: middle; fill: #8a6d42; }
  .secret-mark { font-size: 12px; font-weight: 700; text-anchor: middle; fill: #fff4dd; }
  .region-chip { font-size: 17px; font-weight: 700; fill: #4a3018; }
</style>
${parts.join('\n')}
</svg>
`;

const banner = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Hand-drawn «paper map» art for the game map app, produced by
 * \`npx tsx scripts/renderPaperMap.ts\` from src/game-map/data.ts.
 * The SVG is inlined so the map page stays a single offline document.
 */
export const PAPER_MAP_SVG = ${JSON.stringify(svg)};
`;

const out = 'src/game-map/ui/paperMap.svg.ts';
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, banner);
writeFileSync('docs/game-map/paper-map.svg', svg);
console.log(`Wrote ${out} (${(banner.length / 1024).toFixed(1)} kB) and docs/game-map/paper-map.svg`);
