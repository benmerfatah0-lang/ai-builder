import type { WorldSummary } from '../../core/persistence/worldRepository';
import { Icon } from '../../ui/Icon';
import type { MapTrainer } from './useMapTrainer';
import { AiPanel } from './panels/AiPanel';

interface ForgeHomeProps {
  active?: boolean;
  worlds: WorldSummary[];
  mapTrainer: MapTrainer;
  storageKind: 'indexeddb' | 'memory';
  notify: (message: string, tone?: 'neutral' | 'success' | 'danger') => void;
  onOpenStudio: () => void;
  onOpenLibrary: () => void;
  onOpenWorld: (id: string) => void;
}

/** WorldForge-inspired landing page, backed by the real local editor. */
export function ForgeHome({ active = true, worlds, mapTrainer, storageKind, notify, onOpenStudio, onOpenLibrary, onOpenWorld }: ForgeHomeProps) {
  return (
    <main className="forge-home" hidden={!active}>
      <div className="forge-home-inner">
        <section className="forge-hero" dir="rtl" aria-labelledby="forge-title">
          <div className="forge-hero-symbol" aria-hidden="true"><Icon name="sparkles" size={21} /></div>
          <p className="forge-kicker">WORLD FORGE · استوديو العوالم</p>
          <h1 id="forge-title">اصنع عالمك من الخيال</h1>
          <p className="forge-hero-copy">ابدأ بفكرة، واكتب تفاصيل عالمك. أنشئ مشهداً ثلاثي الأبعاد ثم عدّله بطريقتك.</p>
          <div className="forge-card">
            <div className="forge-card-heading">
              <span className="forge-card-icon"><Icon name="sparkles" size={18} /></span>
              <div><span>THE INCANTATION</span><h2>صف عالمك</h2></div>
            </div>
            <AiPanel variant="forge" active={active} mapTrainer={mapTrainer} notify={notify} onOpenStudio={onOpenStudio} />
          </div>
          <button type="button" className="forge-studio-link" onClick={onOpenStudio}>
            <Icon name="cube" size={16} /> افتح المحرر مباشرةً
          </button>
        </section>

        <section className="forge-recent" dir="rtl" aria-labelledby="recent-worlds-heading">
          <div className="forge-recent-heading">
            <div><p>YOUR WORLDS</p><h2 id="recent-worlds-heading">عوالمك الأخيرة</h2></div>
            <button type="button" onClick={onOpenLibrary}>عرض المكتبة ←</button>
          </div>
          {worlds.length ? (
            <div className="forge-worlds">
              {worlds.slice(0, 3).map((world) => (
                <button className="forge-world" type="button" key={world.id} onClick={() => onOpenWorld(world.id)} aria-label={`فتح ${world.name}`}>
                  <span className="forge-world-icon"><Icon name="cube" size={20} /></span>
                  <span className="forge-world-info"><strong>{world.name}</strong><small>{world.objectCount} عنصر · {storageKind === 'indexeddb' ? 'محفوظ على هذا المتصفح' : 'مؤقت لهذه الجلسة'}</small></span>
                  <span aria-hidden="true">←</span>
                </button>
              ))}
            </div>
          ) : <div className="forge-empty"><Icon name="sparkles" size={24} /><p>عوالمك المحفوظة ستظهر هنا.</p></div>}
        </section>
        <footer className="forge-footer">WorldForge · قوة الإبداع بين يديك</footer>
      </div>
    </main>
  );
}
