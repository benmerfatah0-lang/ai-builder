import { useEffect, useRef, useState } from 'react';
import { BOSSES, REGIONS } from '../data';
import type { RegionId } from '../types';
import { PAPER_MAP_SVG } from './paperMap.svg';

/**
 * The paper-map view: the generated SVG art with pan/zoom, plus a clickable
 * index of regions that drives the same selection as the 3D diorama.
 */

export interface PaperMapViewProps {
  selectedRegion: RegionId | null;
  onRegionSelect: (regionId: RegionId) => void;
  onBossSelect: (bossId: string) => void;
  onOpen3D: () => void;
}

export function PaperMapView({ selectedRegion, onRegionSelect, onBossSelect, onOpen3D }: PaperMapViewProps) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setZoom((value) => Math.min(3.2, Math.max(0.55, value * (event.deltaY < 0 ? 1.09 : 0.92))));
    };
    frame.addEventListener('wheel', onWheel, { passive: false });
    return () => frame.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    // Clicking a boss badge in the SVG routes through the same selectors as the
    // 3D map. The SVG is static markup, so wire it with a delegated listener.
    const frame = frameRef.current;
    if (!frame) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element;
      if (target.closest('[data-boss]')) {
        const id = target.closest('[data-boss]')?.getAttribute('data-boss');
        if (id) onBossSelect(id);
      }
    };
    frame.addEventListener('click', onClick);
    return () => frame.removeEventListener('click', onClick);
  }, [onBossSelect]);

  return (
    <div className="paper-view">
      <div
        ref={frameRef}
        className="paper-view-frame"
        onPointerDown={(event) => {
          dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
          (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!dragRef.current) return;
          const dx = event.clientX - dragRef.current.x;
          const dy = event.clientY - dragRef.current.y;
          setOffset({ x: dragRef.current.ox + dx, y: dragRef.current.oy + dy });
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
      >
        <div
          className="paper-view-sheet"
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
          dangerouslySetInnerHTML={{ __html: PAPER_MAP_SVG }}
        />
      </div>

      <aside className="paper-view-side">
        <div className="paper-view-side-inner">
          <p className="map-kicker">الخريطة الورقية</p>
          <h2>مخطط المستويات</h2>
          <p className="paper-view-note">
            نسخة للطباعة والقراءة السريعة — نفس بيانات الديوراما ثلاثية الأبعاد. اسحب للتحريك، وعجلة الماوس
            للتكبير.
          </p>
          <div className="paper-view-list">
            {REGIONS.map((region) => (
              <button
                key={region.id}
                type="button"
                className={selectedRegion === region.id ? 'is-active' : ''}
                onClick={() => onRegionSelect(region.id)}
                style={{ ['--region-color' as string]: region.color }}
              >
                <span className="paper-view-swatch" />
                <span>
                  <strong>{region.name}</strong>
                  <small>{region.tagline}</small>
                </span>
              </button>
            ))}
          </div>
          <h3>⚔️ البوسات</h3>
          <div className="paper-view-bosses">
            {BOSSES.map((boss) => (
              <button key={boss.id} type="button" className={`tier-${boss.tier}`} onClick={() => onBossSelect(boss.id)}>
                <span>{boss.emoji}</span>
                {boss.name}
              </button>
            ))}
          </div>
          <div className="paper-view-actions">
            <button type="button" onClick={() => setZoom((value) => Math.min(3.2, value * 1.2))}>＋ تكبير</button>
            <button type="button" onClick={() => setZoom((value) => Math.max(0.55, value / 1.2))}>－ تصغير</button>
            <button
              type="button"
              onClick={() => {
                setZoom(1);
                setOffset({ x: 0, y: 0 });
              }}
            >
              ⟲ إعادة الضبط
            </button>
          </div>
          <button type="button" className="paper-view-cta" onClick={onOpen3D}>
            🏔️ العودة إلى الديوراما ثلاثية الأبعاد
          </button>
          <a className="paper-view-link" href="/docs/game-map/paper-map.svg" target="_blank" rel="noreferrer">
            ↗ فتح ملف SVG كامل
          </a>
        </div>
      </aside>
    </div>
  );
}
