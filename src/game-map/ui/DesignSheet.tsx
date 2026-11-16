import {
  BALANCE_TARGETS,
  BOSSES,
  BOSS_ORDER,
  CHECKPOINTS,
  GUIDE,
  LOOP_NOTES,
  MAIN_ROUTE,
  REGIONS,
  SHORTCUTS,
  STATS,
} from '../data';

/**
 * The written design sheet: the "designer's bible" tab. Text-first so the map
 * remains fully readable without WebGL, and print-friendly.
 */

export function DesignSheet() {
  return (
    <div className="design-sheet" dir="rtl">
      <header className="design-sheet-hero">
        <p className="map-kicker">ملف تصميم المستويات</p>
        <h2>خريطة «زعتر والحضيرة العظمى»</h2>
        <p>
          ورقة تصميم كاملة للخريطة ثلاثية الأبعاد: الفكرة، الهيكل، منحنى الصعوبة، نقاط الحفظ، الاختصارات،
          وتصميم كل بوس من حيوانات المزرعة. هذه الورقة هي المرجع الذي بُنيت عليه الديوراما ثلاثية الأبعاد
          والخريطة الورقية.
        </p>
        <div className="design-sheet-stats">
          {[
            [STATS.regions, 'مناطق (٣ أساسية + مقدمة + خاتمة)'],
            [STATS.bosses, 'بوسات من حيوانات المزرعة'],
            [STATS.checkpoints, 'نقاط حفظ'],
            [STATS.arenas, 'أرينات'],
            [STATS.landmarks, 'علامة على الخريطة'],
            [STATS.roads, 'ممرّات ودروب'],
          ].map(([value, labelText]) => (
            <div key={String(labelText)}>
              <strong>{value}</strong>
              <span>{labelText}</span>
            </div>
          ))}
        </div>
      </header>

      <section className="design-sheet-section">
        <h3>١ — الفكرة والهيكل</h3>
        <div className="design-sheet-columns">
          {GUIDE.map((section) => (
            <article key={section.title}>
              <h4>{section.title}</h4>
              <p>{section.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="design-sheet-section">
        <h3>٢ — المناطق على التوالي</h3>
        <div className="design-sheet-regions">
          {REGIONS.map((region) => (
            <article key={region.id} style={{ ['--region-color' as string]: region.color }}>
              <header>
                <span className="design-sheet-emoji">{region.emoji}</span>
                <div>
                  <p>{region.kicker}</p>
                  <h4>{region.name}</h4>
                </div>
              </header>
              <p className="design-sheet-tagline">{region.tagline}</p>
              <ol>
                {region.beats.map((beat) => (
                  <li key={beat.title}>
                    <strong>{beat.title}</strong> — {beat.detail}
                  </li>
                ))}
              </ol>
              <p className="design-sheet-meta">
                <span>👾 {region.encounters.length} لقاءات</span>
                <span>⚠️ {region.hazards.length} مخاطر</span>
                <span>🎁 {region.loot.length} غنائم</span>
                <span>🔎 {region.secrets.length} أسرار</span>
              </p>
            </article>
          ))}
        </div>
      </section>

      <section className="design-sheet-section">
        <h3>٣ — خط سير زعتر (Hub &amp; Spoke)</h3>
        <div className="design-sheet-route">
          {MAIN_ROUTE.map((stop, index) => (
            <div key={`${stop.label}-${index}`} className={`design-sheet-stop stop-${stop.kind}`}>
              <span className="design-sheet-stop-index">{index + 1}</span>
              <strong>{stop.label}</strong>
              <small>({stop.at[0]}، {stop.at[1]})</small>
            </div>
          ))}
        </div>
        <ul className="design-sheet-loops">
          {LOOP_NOTES.map((loop) => (
            <li key={`${loop.from}-${loop.to}`}>
              <strong>{loop.from} ← {loop.to}</strong>
              <span>{loop.note}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="design-sheet-section">
        <h3>٤ — البوسات الخمسة</h3>
        <div className="design-sheet-bosses">
          {BOSS_ORDER.map((id, index) => {
            const boss = BOSSES.find((entry) => entry.id === id)!;
            return (
              <article key={boss.id} className={`tier-${boss.tier}`}>
                <header>
                  <span className="design-sheet-boss-rank">{index + 1}</span>
                  <span className="design-sheet-emoji">{boss.emoji}</span>
                  <div>
                    <h4>{boss.name}</h4>
                    <p>{boss.epithet} · {boss.level}</p>
                  </div>
                  <span className="design-sheet-difficulty">
                    {[1, 2, 3, 4, 5].map((level) => (
                      <i key={level} className={level <= boss.difficulty ? 'is-on' : ''} />
                    ))}
                  </span>
                </header>
                <p className="design-sheet-quote">«{boss.quote}»</p>
                <p>{boss.intro}</p>
                <h5>المراحل</h5>
                <ul>
                  {boss.phases.map((phase) => (
                    <li key={phase.name}>
                      <strong>{phase.name}:</strong> {phase.detail}
                    </li>
                  ))}
                </ul>
                <h5>نقاط الضعف</h5>
                <ul>
                  {boss.weaknesses.map((weakness) => (
                    <li key={weakness}>{weakness}</li>
                  ))}
                </ul>
                <p className="design-sheet-note">📝 {boss.designNote}</p>
              </article>
            );
          })}
        </div>
      </section>

      <section className="design-sheet-section design-sheet-columns">
        <article>
          <h3>٥ — الاختصارات والحلقات</h3>
          <ul className="design-sheet-loops">
            {SHORTCUTS.map((shortcut) => (
              <li key={shortcut.id}>
                <strong>{shortcut.name}</strong>
                <span>{shortcut.from} ← {shortcut.to}</span>
                <span className="design-sheet-unlock">🔓 {shortcut.unlock}</span>
                <span>{shortcut.note}</span>
              </li>
            ))}
          </ul>
        </article>
        <article>
          <h3>٦ — نقاط الحفظ</h3>
          <ul className="design-sheet-checkpoints">
            {CHECKPOINTS.map((checkpoint) => (
              <li key={checkpoint.id}>
                <strong>🔥 {checkpoint.name}</strong>
                <span>{checkpoint.note}</span>
                {checkpoint.unlocks && <em>↪ {checkpoint.unlocks}</em>}
              </li>
            ))}
          </ul>
        </article>
        <article>
          <h3>٧ — أرقام التوازن</h3>
          <dl className="design-sheet-balance">
            {BALANCE_TARGETS.map((target) => (
              <div key={target.label}>
                <dt>{target.label}</dt>
                <dd>{target.value}</dd>
              </div>
            ))}
          </dl>
        </article>
      </section>

      <footer className="design-sheet-foot">
        هذا الملف وُلد من نفس بيانات الخريطة ثلاثية الأبعاد — أي تعديل في الموقع أو المنطقة يظهر تلقائيًا هنا
        وفي الخريطة الورقية.
      </footer>
    </div>
  );
}
