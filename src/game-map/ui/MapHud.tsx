import { useState } from 'react';
import type { BossDef, RegionDef } from '../types';

/**
 * Left rail: the five bosses in recommended order, with tier colour coding and
 * a live hover highlight linked to the 3D diorama.
 */

export interface MapHudProps {
  bosses: BossDef[];
  regions: RegionDef[];
  selectedBoss: string | null;
  hoveredBoss: string | null;
  onBossSelect: (bossId: string) => void;
  onRegionSelect: (regionId: BossDef['regionId']) => void;
}

const TIER_LABEL: Record<BossDef['tier'], string> = {
  required: 'رئيسي',
  optional: 'اختياري',
  final: 'نهائي',
};

export function MapHud({ bosses, regions, selectedBoss, hoveredBoss, onBossSelect, onRegionSelect }: MapHudProps) {
  // Collapsed by default. On a phone this list, the side panel and the minimap
  // were fighting over the same bottom half of the screen and the map itself was
  // mostly hidden; the route is reference material, not something to stare at
  // while walking, so it opens on demand.
  const [open, setOpen] = useState(false);
  return (
    <aside className={`map-hud${open ? ' is-open' : ''}`} aria-label="مسار البوسات">
      <button
        type="button"
        className="map-hud-head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="map-kicker">خط سير زعتر</span>
        <h2>
          خمس بوابات… وخاتمة
          <span className="map-hud-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
        </h2>
      </button>
      <ol className="map-hud-list">
        {bosses.map((boss, index) => {
          const region = regions.find((entry) => entry.id === boss.regionId);
          const state = boss.id === selectedBoss ? 'is-active' : boss.id === hoveredBoss ? 'is-hover' : '';
          return (
            <li key={boss.id} className={`map-hud-item ${state} tier-${boss.tier}`}>
              <button type="button" onClick={() => onBossSelect(boss.id)}>
                <span className="map-hud-index">{index + 1}</span>
                <span className="map-hud-emoji">{boss.emoji}</span>
                <span className="map-hud-text">
                  <span className="map-hud-name">
                    {boss.name}
                    <span className="map-hud-tier">{TIER_LABEL[boss.tier]}</span>
                  </span>
                  <span className="map-hud-sub">{boss.epithet}</span>
                </span>
                <span className="map-hud-region" style={{ background: region?.color }}>
                  {region?.shortName}
                </span>
              </button>
              {index < bosses.length - 1 && <span className="map-hud-link" aria-hidden="true" />}
            </li>
          );
        })}
      </ol>
      <div className="map-hud-foot">
        {regions
          .filter((region) => region.id !== 'start' && region.id !== 'final')
          .map((region) => (
            <button
              key={region.id}
              type="button"
              onClick={() => onRegionSelect(region.id)}
              style={{ ['--region-color' as string]: region.color }}
            >
              <span className="map-hud-region-dot" />
              {region.name}
            </button>
          ))}
      </div>
    </aside>
  );
}
