import { useEffect, useRef, useState } from 'react';
import type { ExploreStatus } from '../explore';

/**
 * Chrome for explore mode: a region/progress readout, a touch pad for phones,
 * and a first-run hint. Nothing here is gameplay — no health, no stamina, no
 * enemies. It exists so the reviewer always knows *where* in the level design
 * they are walking.
 */

export interface ExploreHudProps {
  status: ExploreStatus;
  /** Called when the touch stick moves, with normalised -1..1 intent. */
  onStick: (forward: number, strafe: number) => void;
  onJump: () => void;
  onSprint: (active: boolean) => void;
  /** Held: slides, carrying momentum instead of braking. */
  onSlide?: (active: boolean) => void;
  /** Toggles the camera's auto-follow behaviour. */
  onAutoFollow?: (active: boolean) => void;
  autoFollow?: boolean;
  sliding?: boolean;
  /** Snaps the boom behind the fox and re-arms auto-follow. */
  onRecentre?: () => void;
  onExit: () => void;
  onReset: () => void;
  /** Re-enters fullscreen: some browsers deny the automatic request. */
  onFullscreen: () => void;
  /**
   * Camera drag, in CSS pixels, from the look pad on a touch device. The stick
   * owns one thumb; this is the other one.
   */
  onLook?: (dx: number, dy: number) => void;
  /** True when the Fullscreen API has actually taken the screen. */
  isFullscreen: boolean;
  /** First-run hint: hides once the fox has moved. */
  showHint: boolean;
  discovered: string | null;
}

const REGION_STOPS = [
  { id: 'start', label: 'حافّة الغابة', emoji: '🌲' },
  { id: 'farm', label: 'المزرعة', emoji: '🏠' },
  { id: 'crops', label: 'الزراعة', emoji: '🌾' },
  { id: 'pens', label: 'الحظائر', emoji: '🐑' },
  { id: 'final', label: 'القصر', emoji: '👑' },
];

/** Which stop index a region id maps to, for the progress rail. */
const stopIndex = (name: string | null): number => {
  const found = REGION_STOPS.findIndex((stop) => stop.label === name);
  return found < 0 ? 0 : found;
};

export function ExploreHud({
  status,
  onStick,
  onJump,
  onSprint,
  onSlide,
  onAutoFollow,
  autoFollow = false,
  sliding = false,
  onRecentre,
  onExit,
  onReset,
  onFullscreen,
  isFullscreen,
  onLook,
  showHint,
  discovered,
}: ExploreHudProps) {
  const padRef = useRef<HTMLDivElement | null>(null);
  const lookRef = useRef<HTMLDivElement | null>(null);
  const [stickActive, setStickActive] = useState(false);
  const activeStop = stopIndex(status.regionName);

  /* --------------------------------------------------------- touch stick */
  useEffect(() => {
    const pad = padRef.current;
    if (!pad) return;
    const knob = pad.querySelector<HTMLElement>('.explore-stick-knob');
    let pointerId: number | null = null;
    let originX = 0;
    let originY = 0;
    const RADIUS = 46;

    const move = (event: PointerEvent) => {
      if (pointerId !== event.pointerId) return;
      const dx = event.clientX - originX;
      const dy = event.clientY - originY;
      const distance = Math.hypot(dx, dy);
      const scale = distance > RADIUS ? RADIUS / distance : 1;
      const knobX = dx * scale;
      const knobY = dy * scale;
      if (knob) knob.style.transform = `translate(${knobX}px, ${knobY}px)`;
      // Screen up = forward. Strafe is horizontal.
      onStick(-knobY / RADIUS, knobX / RADIUS);
    };

    const end = (event: PointerEvent) => {
      // Always stop on pointerup, whatever the id: a lost id used to leave the
      // fox walking forever because the release was filtered out.
      if (pointerId !== null && pointerId !== event.pointerId) return;
      pointerId = null;
      setStickActive(false);
      if (knob) knob.style.transform = 'translate(0, 0)';
      onStick(0, 0);
    };

    const start = (event: PointerEvent) => {
      event.preventDefault();
      pointerId = event.pointerId;
      // Anchor the stick where the thumb actually landed. Snapping the origin
      // to the pad centre made the first frame jump: touching the edge sent the
      // knob (and the fox) a full radius away instantly.
      originX = event.clientX;
      originY = event.clientY;
      setStickActive(true);
      onStick(0, 0);
    };

    pad.addEventListener('pointerdown', start);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      pad.removeEventListener('pointerdown', start);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [onStick]);

  /* ---------------------------------------------------------- look pad */
  useEffect(() => {
    const pad = lookRef.current;
    if (!pad || !onLook) return;
    let pointerId: number | null = null;
    let lastX = 0;
    let lastY = 0;
    const start = (event: PointerEvent) => {
      if (pointerId !== null) return;
      event.preventDefault();
      pointerId = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      pad.setPointerCapture?.(event.pointerId);
      pad.classList.add('is-active');
    };
    const move = (event: PointerEvent) => {
      if (pointerId !== event.pointerId) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      if (dx === 0 && dy === 0) return;
      onLook(dx, dy);
    };
    const end = (event: PointerEvent) => {
      if (pointerId !== null && pointerId !== event.pointerId) return;
      pointerId = null;
      pad.classList.remove('is-active');
    };
    pad.addEventListener('pointerdown', start);
    pad.addEventListener('pointermove', move);
    pad.addEventListener('pointerup', end);
    pad.addEventListener('pointercancel', end);
    return () => {
      pad.removeEventListener('pointerdown', start);
      pad.removeEventListener('pointermove', move);
      pad.removeEventListener('pointerup', end);
      pad.removeEventListener('pointercancel', end);
    };
  }, [onLook]);

  return (
    <div className="explore-ui">
      {/* Top-left: where am I + progress along the spine. */}
      <div className="explore-status">
        <p className="explore-kicker">وضع الاستكشاف · زعتر</p>
        <h2 className="explore-region">
          {status.regionName ? (
            <>
              <span aria-hidden="true">{REGION_STOPS[activeStop]?.emoji}</span> {status.regionName}
            </>
          ) : (
            'بين المناطق'
          )}
        </h2>
        {status.wading && <p className="explore-badge">💧 يخوض الماء — الحركة أبطأ</p>}
        {status.sprinting && <p className="explore-badge explore-badge--run">🏃 يجري</p>}

        <ol className="explore-rail" aria-label="تقدّم زعتر من الغابة إلى القصر">
          {REGION_STOPS.map((stop, index) => (
            <li
              key={stop.id}
              className={index === activeStop ? 'is-current' : index < activeStop ? 'is-done' : ''}
            >
              <span className="explore-rail-dot" />
              <span className="explore-rail-label">{stop.label}</span>
            </li>
          ))}
        </ol>
        <div className="explore-progress" aria-hidden="true">
          <span style={{ width: `${Math.round(status.progress * 100)}%` }} />
        </div>
      </div>

      {discovered && <div className="explore-toast">🔥 اكتشفت {discovered}</div>}

      {showHint && (
        <div className="explore-hint">
          <div className="explore-hint-keys">
            <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>
            <span>حركة</span>
            <kbd>Shift</kbd><span>جري</span>
            <kbd>Space</kbd><span>قفز</span>
            <kbd>Ctrl</kbd><span>انزلاق</span>
            <kbd>Q</kbd><kbd>E</kbd><span>تدوير</span>
            <kbd>V</kbd><span>تتبّع</span>
            <kbd>R</kbd><span>رجوع</span>
          </div>
          <p>
            على الجوّال: العصا أسفل اليسار للحركة، وقرص <span aria-hidden="true">⟲</span> أسفل
            اليمين لتدوير الكاميرا — زعتر يمشي حيث تنظر. زر <span aria-hidden="true">🎯</span>{' '}
            يجعل الكاميرا تتبعه وحدها.
          </p>
        </div>
      )}

      {/* Bottom-left: touch stick, phones only (CSS hides it on pointer:fine). */}
      <div
        ref={padRef}
        className={`explore-stick${stickActive ? ' is-active' : ''}`}
        role="group"
        aria-label="عصا التحكّم"
      >
        <span className="explore-stick-knob" />
      </div>

      {/* Bottom-right corner, above the buttons: the other thumb turns the view. */}
      <div
        ref={lookRef}
        className="explore-look"
        role="group"
        aria-label="تدوير الكاميرا"
      >
        <span aria-hidden="true">⟲</span>
      </div>

      {/* Bottom-right: movement verbs, then view verbs. */}
      <div className="explore-actions">
        <button
          type="button"
          className="explore-btn explore-btn--jump"
          onClick={onJump}
          aria-label="قفز"
          title="قفز · Space"
        >
          ⤒
        </button>
        <button
          type="button"
          className={`explore-btn explore-btn--run${sliding ? ' is-active' : ''}`}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture?.(event.pointerId);
            onSlide?.(true);
          }}
          onPointerUp={() => onSlide?.(false)}
          onPointerCancel={() => onSlide?.(false)}
          onPointerLeave={() => onSlide?.(false)}
          aria-label="انزلق"
          title="انزلق · Ctrl أو C"
        >
          ⤓
        </button>
        <button
          type="button"
          className="explore-btn explore-btn--run"
          onPointerDown={() => onSprint(true)}
          onPointerUp={() => onSprint(false)}
          onPointerLeave={() => onSprint(false)}
          aria-label="جري"
          title="جري · Shift"
        >
          🏃
        </button>
        <button
          type="button"
          className={`explore-btn${autoFollow ? ' is-active' : ''}`}
          onClick={() => {
            onAutoFollow?.(!autoFollow);
            onRecentre?.();
          }}
          aria-label={autoFollow ? 'الكاميرا تتبع زعتر · إيقاف' : 'ثبّت الكاميرا خلف زعتر'}
          title="تثبيت الكاميرا خلف زعتر · V"
        >
          🎯
        </button>
        <button type="button" className="explore-btn" onClick={onReset} aria-label="عُد إلى البداية" title="عُد إلى البداية · R">
          ↺
        </button>
        {/* Some browsers refuse the automatic request without a fresh gesture,
            so the screen can still be restored by hand. Hidden once it worked. */}
        {!isFullscreen && (
          <button
            type="button"
            className="explore-btn explore-btn--wide"
            onClick={onFullscreen}
            aria-label="ملء الشاشة"
          >
            ⛶
          </button>
        )}
        <button type="button" className="explore-exit" onClick={onExit}>
          ✕ خروج من الاستكشاف
        </button>
      </div>
    </div>
  );
}
