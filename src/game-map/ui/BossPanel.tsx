import type { BossDef } from '../types';

/**
 * Boss dossier: the melee design of one fight — phases, arena mechanics,
 * weaknesses, rewards and a designer's note.
 */

export interface BossPanelProps {
  boss: BossDef;
  onClose: () => void;
  onRegion: () => void;
}

const TIER_COPY: Record<BossDef['tier'], string> = {
  required: 'بوس رئيسي — مطلوب للتقدّم',
  optional: 'بوس اختياري — مكافأة مقابل خطر',
  final: 'البوس النهائي',
};

export function BossPanel({ boss, onClose, onRegion }: BossPanelProps) {
  return (
    <section className={`map-panel map-panel--boss tier-${boss.tier}`}>
      <header className="map-boss-head">
        <div className="map-boss-portrait">
          <span>{boss.emoji}</span>
          <small>{boss.species}</small>
        </div>
        <div className="map-boss-title">
          <p className="map-kicker">{TIER_COPY[boss.tier]}</p>
          <h2>{boss.name}</h2>
          <p>{boss.epithet}</p>
          <div className="map-boss-meta">
            <span>{boss.level}</span>
            <span className="map-difficulty" aria-label={`الصعوبة ${boss.difficulty} من 5`}>
              {[1, 2, 3, 4, 5].map((level) => (
                <i key={level} className={level <= boss.difficulty ? 'is-on' : ''} />
              ))}
            </span>
            <span>❤ {boss.hp}</span>
          </div>
        </div>
        <button type="button" className="map-icon-button" onClick={onClose} aria-label="إغلاق ملف البوس">
          ✕
        </button>
      </header>

      <blockquote className="map-boss-quote">«{boss.quote}»</blockquote>
      <p className="map-boss-intro">{boss.intro}</p>

      <div className="map-panel-block">
        <h3>🌀 مراحل المعركة</h3>
        <ol className="map-phases">
          {boss.phases.map((phase) => (
            <li key={phase.name}>
              <strong>{phase.name}</strong>
              <span>{phase.detail}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="map-panel-block">
        <h3>🎭 ميكانيكيات الأرينا</h3>
        <ul>
          {boss.arenaMechanics.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>

      <div className="map-panel-grid">
        <div className="map-panel-block map-panel-block--loot">
          <h3>🎯 نقاط الضعف</h3>
          <ul>
            {boss.weaknesses.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div className="map-panel-block map-panel-block--secret">
          <h3>🏆 المكافآت</h3>
          <ul>
            {boss.rewards.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="map-designer-note">
        <span>📝 ملاحظة المصمّم</span>
        <p>{boss.designNote}</p>
      </div>

      <button type="button" className="map-back-button" onClick={onRegion}>
        ↪ ملف المنطقة: {boss.regionId === 'crops' ? 'الزراعة' : boss.regionId === 'pens' ? 'الحظائر' : boss.regionId === 'final' ? 'القصر' : 'المزرعة'}
      </button>
    </section>
  );
}
