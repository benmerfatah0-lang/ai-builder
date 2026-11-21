// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExploreHud } from './ExploreHud';
import type { ExploreStatus } from '../explore';

/**
 * The explore HUD is the only way a player learns the controls, so its content
 * is worth pinning: the region readout, the five-stop rail, the three buttons
 * and the exit affordance must all be present and wired.
 */

afterEach(() => cleanup());

const status = (overrides: Partial<ExploreStatus> = {}): ExploreStatus => ({
  x: 0,
  z: 128,
  speed: 0,
  sprinting: false,
  regionName: 'المزرعة',
  progress: 0.42,
  wading: false,
  ...overrides,
});

const setup = (overrides: Partial<ExploreStatus> = {}, extra: Record<string, unknown> = {}) => {
  const handlers = {
    onStick: vi.fn(),
    onJump: vi.fn(),
    onSprint: vi.fn(),
    onExit: vi.fn(),
  onFullscreen: vi.fn(),
  isFullscreen: false,
    onReset: vi.fn(),
  };
  const view = render(
    <ExploreHud
      status={status(overrides)}
      discovered={null}
      showHint
      {...handlers}
      {...extra}
    />,
  );
  return { ...handlers, ...view };
};

describe('ExploreHud', () => {
  it('shows the current region and the full progress rail', () => {
    const { container } = setup();
    // The region shows in the heading and again in the rail; both are expected.
    expect(container.querySelector('.explore-region')?.textContent).toContain('المزرعة');
    for (const label of ['حافّة الغابة', 'المزرعة', 'الزراعة', 'الحظائر', 'القصر']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it('marks the current stop and fills the progress bar', () => {
    const { container } = setup({ progress: 0.5 });
    const current = container.querySelector('.explore-rail li.is-current');
    expect(current?.textContent).toContain('المزرعة');
    const bar = container.querySelector<HTMLElement>('.explore-progress span');
    expect(bar?.style.width).toBe('50%');
  });

  it('announces wading and sprinting states', () => {
    setup({ wading: true, sprinting: true });
    expect(screen.getByText(/يخوض الماء/)).toBeTruthy();
    expect(screen.getByText(/يجري/)).toBeTruthy();
  });

  it('exposes jump, sprint, reset and exit', () => {
    const { onJump, onSprint, onReset, onExit } = setup();
    fireEvent.click(screen.getByLabelText('قفز'));
    expect(onJump).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('عُد إلى البداية'));
    expect(onReset).toHaveBeenCalled();
    fireEvent.click(screen.getByText(/خروج من الاستكشاف/));
    expect(onExit).toHaveBeenCalled();

    const run = screen.getByLabelText('جري');
    fireEvent.pointerDown(run);
    expect(onSprint).toHaveBeenCalledWith(true);
    fireEvent.pointerUp(run);
    expect(onSprint).toHaveBeenCalledWith(false);
  });

  it('hides the keyboard hint after the first move', () => {
    setup({}, { showHint: false });
    expect(screen.queryByText(/للحركة/)).toBeNull();
  });

  it('shows a discovery toast when a checkpoint is found', () => {
    setup({}, { discovered: 'بئر الحوش' });
    expect(screen.getByText(/اكتشفت بئر الحوش/)).toBeTruthy();
  });
});
