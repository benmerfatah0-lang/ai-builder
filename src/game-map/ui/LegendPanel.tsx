import { BALANCE_TARGETS, LEGEND } from '../data';

/**
 * Legend + layer switches + quick-travel presets at the bottom of the side rail.
 */

export interface LegendPanelProps {
  showRoute: boolean;
  showRegions: boolean;
  showArenas: boolean;
  showLabels: boolean;
  onRoute: (value: boolean) => void;
  onRegions: (value: boolean) => void;
  onArenas: (value: boolean) => void;
  onLabels: (value: boolean) => void;
  onGoTo: (preset: string) => void;
}

export function LegendPanel({
  showRoute,
  showRegions,
  showArenas,
  showLabels,
  onRoute,
  onRegions,
  onArenas,
  onLabels,
  onGoTo,
}: LegendPanelProps) {
  return (
    <section className="map-panel map-panel--legend">
      <h3>🗝️ مفتاح الرموز</h3>
      <ul className="map-legend">
        {LEGEND.map((item) => (
          <li key={item.label}>
            <span className={`map-legend-mark shape-${item.shape}`} style={{ background: item.color }} />
            {item.label}
          </li>
        ))}
      </ul>

      <h3>🧱 الطبقات</h3>
      <div className="map-layer-list">
        <label>
          <input type="checkbox" checked={showRoute} onChange={(event) => onRoute(event.target.checked)} />
          <span>المسار المقترح</span>
        </label>
        <label>
          <input type="checkbox" checked={showRegions} onChange={(event) => onRegions(event.target.checked)} />
          <span>حدود المناطق</span>
        </label>
        <label>
          <input type="checkbox" checked={showArenas} onChange={(event) => onArenas(event.target.checked)} />
          <span>حلقات الأرينات</span>
        </label>
        <label>
          <input type="checkbox" checked={showLabels} onChange={(event) => onLabels(event.target.checked)} />
          <span>منارة المنطقة المختارة</span>
        </label>
      </div>

      <h3>⚡ انتقال سريع</h3>
      <div className="map-presets">
        {[
          { id: 'overview', label: 'نظرة عامة', icon: '🗺️' },
          { id: 'start', label: 'البداية', icon: '🌲' },
          { id: 'farm', label: 'المزرعة', icon: '🏠' },
          { id: 'crops', label: 'الزراعة', icon: '🌾' },
          { id: 'pens', label: 'الحظائر', icon: '🐑' },
          { id: 'finale', label: 'القصر', icon: '👑' },
          { id: 'top', label: 'من أعلى', icon: '🧭' },
        ].map((preset) => (
          <button key={preset.id} type="button" onClick={() => onGoTo(preset.id)}>
            <span>{preset.icon}</span>
            {preset.label}
          </button>
        ))}
      </div>

      <h3>📊 أرقام التصميم</h3>
      <dl className="map-balance">
        {BALANCE_TARGETS.map((target) => (
          <div key={target.label}>
            <dt>{target.label}</dt>
            <dd>{target.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
