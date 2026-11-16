import { BOSSES, CHECKPOINTS, LANDMARKS } from '../data';
import type { RegionDef } from '../types';

/**
 * Right-hand dossier for the selected region: the level-design pitch — mood,
 * beats, encounters, hazards, loot and secrets.
 */

export interface RegionPanelProps {
  region: RegionDef | null;
  onBossSelect: (bossId: string) => void;
}

export function RegionPanel({ region, onBossSelect }: RegionPanelProps) {
  if (!region) {
    return (
      <section className="map-panel map-panel--empty">
        <h2>اختر منطقة</h2>
        <p>انقر أي بقعة على الخريطة، أو استخدم التبويبات في الأعلى، لقراءة ملفّ تصميمها.</p>
      </section>
    );
  }

  const bosses = BOSSES.filter((boss) => boss.regionId === region.id);
  const checkpoints = region.id === 'final' ? [] : CHECKPOINTS.filter((checkpoint) => {
    const [x, z] = checkpoint.position;
    return (
      x >= Math.min(...region.polygon.map((point) => point[0])) &&
      x <= Math.max(...region.polygon.map((point) => point[0])) &&
      z >= Math.min(...region.polygon.map((point) => point[1])) &&
      z <= Math.max(...region.polygon.map((point) => point[1]))
    );
  });
  const npcs = LANDMARKS.filter((landmark) => landmark.regionId === region.id && landmark.kind === 'npc');
  const shortcuts = LANDMARKS.filter((landmark) => landmark.regionId === region.id && landmark.kind === 'shortcut');

  return (
    <section
      className="map-panel map-panel--region"
      style={{ ['--region-color' as string]: region.color, ['--region-deep' as string]: region.deep }}
    >
      <header className="map-panel-head">
        <span className="map-panel-emoji">{region.emoji}</span>
        <div>
          <p className="map-kicker">{region.kicker}</p>
          <h2>{region.name}</h2>
          <p className="map-panel-tagline">{region.tagline}</p>
        </div>
      </header>

      <p className="map-panel-summary">{region.summary}</p>
      <p className="map-mood">🌤️ {region.mood}</p>

      <div className="map-panel-stats">
        <div>
          <strong>{region.beats.length}</strong>
          <span>محطات</span>
        </div>
        <div>
          <strong>{bosses.length}</strong>
          <span>بوسات</span>
        </div>
        <div>
          <strong>{checkpoints.length}</strong>
          <span>نقاط حفظ</span>
        </div>
        <div>
          <strong>{region.secrets.length}</strong>
          <span>أسرار</span>
        </div>
      </div>

      {bosses.length > 0 && (
        <div className="map-panel-block">
          <h3>⚔️ بوسات المنطقة</h3>
          <div className="map-boss-cards">
            {bosses.map((boss) => (
              <button key={boss.id} type="button" className={`map-boss-card tier-${boss.tier}`} onClick={() => onBossSelect(boss.id)}>
                <span className="map-boss-card-emoji">{boss.emoji}</span>
                <span>
                  <strong>{boss.name}</strong>
                  <small>{boss.epithet} · {boss.level}</small>
                </span>
                <span className="map-boss-card-arrow">←</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="map-panel-block">
        <h3>🧩 محطات التصميم</h3>
        <ol className="map-beats">
          {region.beats.map((beat) => (
            <li key={beat.title}>
              <span className="map-beat-title">{beat.title}</span>
              <span className="map-beat-detail">{beat.detail}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="map-panel-grid">
        <div className="map-panel-block">
          <h3>🎯 الأهداف</h3>
          <ul>
            {region.objectives.map((objective) => (
              <li key={objective}>{objective}</li>
            ))}
          </ul>
        </div>
        <div className="map-panel-block">
          <h3>👾 اللقاءات</h3>
          <ul>
            {region.encounters.map((encounter) => (
              <li key={encounter}>{encounter}</li>
            ))}
          </ul>
        </div>
        <div className="map-panel-block map-panel-block--danger">
          <h3>⚠️ المخاطر</h3>
          <ul>
            {region.hazards.map((hazard) => (
              <li key={hazard}>{hazard}</li>
            ))}
          </ul>
        </div>
        <div className="map-panel-block map-panel-block--loot">
          <h3>🎁 الغنائم</h3>
          <ul>
            {region.loot.map((loot) => (
              <li key={loot}>{loot}</li>
            ))}
          </ul>
        </div>
        <div className="map-panel-block map-panel-block--secret">
          <h3>🔎 الأسرار</h3>
          <ul>
            {region.secrets.map((secret) => (
              <li key={secret}>{secret}</li>
            ))}
          </ul>
        </div>
        {(npcs.length > 0 || shortcuts.length > 0 || checkpoints.length > 0) && (
          <div className="map-panel-block">
            <h3>🧭 على الأرض</h3>
            <ul>
              {npcs.map((npc) => (
                <li key={npc.id}>
                  {npc.emoji} {npc.name} — {npc.note}
                </li>
              ))}
              {shortcuts.map((shortcut) => (
                <li key={shortcut.id}>
                  {shortcut.emoji} {shortcut.name} — {shortcut.note}
                </li>
              ))}
              {checkpoints.map((checkpoint) => (
                <li key={checkpoint.id}>🔥 {checkpoint.name} — {checkpoint.note}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
