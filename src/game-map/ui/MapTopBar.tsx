import { useState } from 'react';
import { MAP_TITLE, REGIONS } from '../data';

/**
 * Top chrome for the standalone map page: title, region fly-to tabs, view
 * mode, cutaway toggle and the guide button.
 */

export interface MapTopBarProps {
  mode: '3d' | 'paper' | 'design';
  onMode: (mode: '3d' | 'paper' | 'design') => void;
  viewMode: 'diorama' | 'top' | 'flythrough';
  onViewMode: (mode: 'diorama' | 'top' | 'flythrough') => void;
  onGoTo: (preset: string) => void;
  onToggleGuide: () => void;
  overlay: 'none' | 'regions' | 'bosses';
  onOverlay: (overlay: 'none' | 'regions' | 'bosses') => void;
}

export function MapTopBar({ mode, onMode, viewMode, onViewMode, onGoTo, onToggleGuide, overlay, onOverlay }: MapTopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <header className="map-topbar">
      <div className="map-brand">
        <span className="map-brand-mark">🦊</span>
        <div>
          <h1>{MAP_TITLE}</h1>
          <p>خريطة العالم ثلاثية الأبعاد · أسلوب Soulslite كرتوني</p>
        </div>
      </div>

      <nav className="map-tabs" aria-label="التنقل بين المناطق">
        <button type="button" className="map-tab map-tab--home" onClick={() => onGoTo('overview')}>
          🗺️ نظرة عامة
        </button>
        {REGIONS.map((region) => (
          <button
            key={region.id}
            type="button"
            className="map-tab"
            style={{ ['--tab-color' as string]: region.color }}
            onClick={() => onGoTo(region.id === 'final' ? 'finale' : region.id)}
          >
            <span className="map-tab-dot" />
            {region.shortName}
          </button>
        ))}
      </nav>

      <div className="map-top-actions">
        <div className="map-seg map-seg--mode" role="group" aria-label="نوع العرض">
          <button type="button" className={mode === '3d' ? 'is-active' : ''} onClick={() => onMode('3d')}>
            🏔️<span>ديوراما</span>
          </button>
          <button type="button" className={mode === 'paper' ? 'is-active' : ''} onClick={() => onMode('paper')}>
            🗞️<span>ورقية</span>
          </button>
          <button type="button" className={mode === 'design' ? 'is-active' : ''} onClick={() => onMode('design')}>
            📐<span>ورقة التصميم</span>
          </button>
        </div>
        <div className="map-seg" role="group" aria-label="طريقة العرض">
          <button
            type="button"
            className={viewMode === 'diorama' ? 'is-active' : ''}
            onClick={() => onViewMode('diorama')}
            title="ديوراما"
          >
            🏔️
            <span>ديوراما</span>
          </button>
          <button
            type="button"
            className={viewMode === 'top' ? 'is-active' : ''}
            onClick={() => onViewMode('top')}
            title="خريطة من أعلى"
          >
            🧭
            <span>من أعلى</span>
          </button>
          <button
            type="button"
            className={viewMode === 'flythrough' ? 'is-active' : ''}
            onClick={() => onViewMode(viewMode === 'flythrough' ? 'diorama' : 'flythrough')}
            title="جولة تلقائية"
          >
            🎥
            <span>جولة</span>
          </button>
        </div>

        <div className="map-menu">
          <button type="button" className="map-action" onClick={() => setMenuOpen((open) => !open)}>
            ⚙️ الطبقات
          </button>
          {menuOpen && (
            <div className="map-menu-pop">
              {[
                { id: 'none', label: 'بدون تظليل', icon: '◻️' },
                { id: 'regions', label: 'تلوين المناطق', icon: '🎨' },
                { id: 'bosses', label: 'مسارات البوسات', icon: '⚔️' },
              ].map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={overlay === item.id ? 'is-active' : ''}
                  onClick={() => {
                    onOverlay(item.id as MapTopBarProps['overlay']);
                    setMenuOpen(false);
                  }}
                >
                  <span>{item.icon}</span>
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <button type="button" className="map-action map-action--primary" onClick={onToggleGuide}>
          📖 دليل الخريطة
        </button>
      </div>
    </header>
  );
}
