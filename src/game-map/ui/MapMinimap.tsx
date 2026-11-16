import { useState } from 'react';
import type { BossDef, CheckpointDef, LandmarkDef, RegionDef, RegionId } from '../types';
import type { MapSelection } from '../GameMap';

/**
 * Hand-drawn SVG minimap: the readable paper-map twin of the 3D diorama.
 * Region polygons, the boss route, checkpoints, arenas and secret markers are
 * drawn from the same data the 3D scene uses, so the two can never drift.
 */

const WORLD = { minX: -126, maxX: 126, minZ: -158, maxZ: 158 };

function toX(x: number) {
  return ((x - WORLD.minX) / (WORLD.maxX - WORLD.minX)) * 100;
}
function toY(z: number) {
  return ((z - WORLD.minZ) / (WORLD.maxZ - WORLD.minZ)) * 100;
}

const ROUTE: [number, number][] = [
  [0, 148], [-6, 138], [0, 118], [2, 66], [-26, 44], [0, 20], [2, -10],
  [10, -60], [10, -80], [14, -96], [44, -98], [-44, -100], [-46, -124],
];

const RIVER: [number, number][] = [
  [-118, -82], [-80, -76], [-40, -84], [0, -80], [40, -86], [80, -76], [118, -72],
];

export interface MapMinimapProps {
  regions: RegionDef[];
  bosses: BossDef[];
  checkpoints: CheckpointDef[];
  landmarks: LandmarkDef[];
  selection: MapSelection | null;
  hovered: string | null;
  onRegionSelect: (regionId: RegionId) => void;
  onBossSelect: (bossId: string) => void;
}

export function MapMinimap({
  regions,
  bosses,
  checkpoints,
  landmarks,
  selection,
  hovered,
  onRegionSelect,
  onBossSelect,
}: MapMinimapProps) {
  const [open, setOpen] = useState(true);
  const secrets = landmarks.filter((landmark) => landmark.kind === 'secret').slice(0, 8);

  return (
    <div className={`map-minimap${open ? ' is-open' : ''}`}>
      <button type="button" className="map-minimap-toggle" onClick={() => setOpen((value) => !value)}>
        <span>🧭</span>
        <span>{open ? 'إخفاء الخريطة الورقية' : 'الخريطة الورقية'}</span>
      </button>
      {open && (
        <div className="map-minimap-frame">
          <svg viewBox="0 0 100 100" role="img" aria-label="خريطة ورقية للحضيرة العظمى">
            <defs>
              <linearGradient id="mm-paper" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#efe3c6" />
                <stop offset="100%" stopColor="#e2d2ad" />
              </linearGradient>
              <pattern id="mm-grid" width="5" height="5" patternUnits="userSpaceOnUse">
                <path d="M 5 0 L 0 0 0 5" fill="none" stroke="#c9b78e" strokeWidth="0.18" />
              </pattern>
            </defs>
            <rect x="0" y="0" width="100" height="100" fill="url(#mm-paper)" rx="2.4" />
            <rect x="0" y="0" width="100" height="100" fill="url(#mm-grid)" rx="2.4" opacity="0.7" />

            {/* River + canal */}
            <polyline
              points={RIVER.map(([x, z]) => `${toX(x)},${toY(z)}`).join(' ')}
              fill="none"
              stroke="#7ab4c6"
              strokeWidth="2.2"
              strokeLinejoin="round"
              opacity="0.9"
            />
            <polyline
              points={([
                [-101, 100], [-101, 40], [-99, -20], [-99, -78],
              ] as [number, number][]).map(([x, z]) => `${toX(x)},${toY(z)}`).join(' ')}
              fill="none"
              stroke="#7ab4c6"
              strokeWidth="0.9"
              opacity="0.75"
            />
            <circle cx={toX(-58)} cy={toY(-60)} r="1.6" fill="#7ab4c6" opacity="0.9" />

            {/* Region polygons */}
            {regions.map((region) => {
              const active = selection?.kind === 'region' && selection.id === region.id;
              return (
                <polygon
                  key={region.id}
                  points={region.polygon.map(([x, z]) => `${toX(x)},${toY(z)}`).join(' ')}
                  fill={region.color}
                  fillOpacity={active ? 0.4 : 0.17}
                  stroke={region.color}
                  strokeWidth={active ? 0.7 : 0.32}
                  strokeDasharray="1.6 1.2"
                  className="mm-region"
                  onClick={() => onRegionSelect(region.id)}
                />
              );
            })}

            {/* Region names */}
            {regions.map((region) => (
              <text
                key={`${region.id}-label`}
                x={toX(region.center[0] ?? 0)}
                y={toY(region.center[1] ?? 0)}
                className="mm-region-label"
                fill={activeOrDark(selection, region.id)}
                textAnchor="middle"
              >
                {region.name}
              </text>
            ))}

            {/* Main route */}
            <polyline
              points={ROUTE.map(([x, z]) => `${toX(x)},${toY(z)}`).join(' ')}
              fill="none"
              stroke="#a9762f"
              strokeWidth="0.55"
              strokeDasharray="1.7 1.1"
              opacity="0.9"
            />

            {/* Arenas */}
            {bosses.map((boss) => (
              <g key={`arena-${boss.id}`}>
                <circle
                  cx={toX(boss.position[0])}
                  cy={toY(boss.position[1])}
                  r="2.1"
                  fill="none"
                  stroke={boss.tier === 'final' ? '#b8860b' : boss.tier === 'optional' ? '#8a5bb0' : '#a33b2e'}
                  strokeWidth="0.42"
                  strokeDasharray="0.9 0.7"
                />
              </g>
            ))}

            {/* Checkpoints */}
            {checkpoints.map((checkpoint) => (
              <circle
                key={checkpoint.id}
                cx={toX(checkpoint.position[0])}
                cy={toY(checkpoint.position[1])}
                r="0.85"
                fill="#f2b93c"
                stroke="#7a4a12"
                strokeWidth="0.22"
              />
            ))}

            {/* Secrets */}
            {secrets.map((secret) => (
              <rect
                key={secret.id}
                x={toX(secret.position[0]) - 0.55}
                y={toY(secret.position[1]) - 0.55}
                width="1.1"
                height="1.1"
                transform={`rotate(45 ${toX(secret.position[0])} ${toY(secret.position[1])})`}
                fill="#c98a2c"
                opacity="0.9"
              />
            ))}

            {/* Boss markers */}
            {bosses.map((boss) => {
              const x = toX(boss.position[0]);
              const y = toY(boss.position[1]);
              const active = selectedBossId(selection) === boss.id;
              const isHovered = hovered === `boss:${boss.id}`;
              const color = boss.tier === 'final' ? '#d4a017' : boss.tier === 'optional' ? '#8a5bb0' : '#a33b2e';
              return (
                <g
                  key={boss.id}
                  className="mm-boss"
                  onClick={() => onBossSelect(boss.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onBossSelect(boss.id);
                  }}
                >
                  <circle cx={x} cy={y} r={active || isHovered ? 1.9 : 1.5} fill={color} stroke="#fff6df" strokeWidth="0.3" />
                  <text x={x} y={y + 0.72} className="mm-boss-icon" textAnchor="middle">
                    {boss.tier === 'final' ? '♛' : boss.tier === 'optional' ? '✦' : '⚔'}
                  </text>
                  <text x={x} y={y - 2.3} className="mm-boss-label" textAnchor="middle">
                    {boss.name}
                  </text>
                </g>
              );
            })}

            {/* Compass */}
            <g transform="translate(91 8)">
              <circle r="4.2" fill="#f4e9cd" stroke="#9c855a" strokeWidth="0.25" />
              <path d="M 0 -3.4 L 1.1 0 L 0 3.4 L -1.1 0 Z" fill="#8a4a2a" />
              <text y="-4.8" className="mm-compass" textAnchor="middle">
                ش
              </text>
            </g>
          </svg>
          <div className="map-minimap-legend">
            <span><i className="dot dot-boss" />بوس</span>
            <span><i className="dot dot-fire" />حفظ</span>
            <span><i className="dot dot-secret" />سرّ</span>
            <span><i className="line-swatch" />المسار</span>
          </div>
        </div>
      )}
    </div>
  );
}

function selectedBossId(selection: MapSelection | null) {
  return selection?.kind === 'boss' ? selection.id : null;
}

function activeOrDark(selection: MapSelection | null, regionId: RegionId) {
  return selection?.kind === 'region' && selection.id === regionId ? '#2f2a22' : 'rgba(47,42,34,0.62)';
}
