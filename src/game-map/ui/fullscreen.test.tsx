// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ExploreHud } from './ExploreHud';

/**
 * Fullscreen affordance: automatic entry can be denied (Safari iPhone, some
 * in-app browsers), and the user may leave with Esc. The button exists so the
 * screen can always be claimed by hand, and disappears once it worked.
 */
const base = {
  status: {
    x: 2,
    z: 128,
    speed: 0,
    sprinting: false,
    regionName: 'المزرعة',
    progress: 0.3,
    wading: false,
  },
  onStick: vi.fn(),
  onJump: vi.fn(),
  onSprint: vi.fn(),
  onExit: vi.fn(),
  onReset: vi.fn(),
  onFullscreen: vi.fn(),
  showHint: true,
  discovered: null,
};

describe('fullscreen affordance', () => {
  it('shows the fullscreen button while not fullscreen', () => {
    const { container } = render(<ExploreHud {...base} isFullscreen={false} />);
    expect(container.querySelector('[aria-label="ملء الشاشة"]')).toBeTruthy();
  });

  it('hides it once the screen is actually fullscreen', () => {
    const { container } = render(<ExploreHud {...base} isFullscreen />);
    expect(container.querySelector('[aria-label="ملء الشاشة"]')).toBeNull();
  });

  it('calls onFullscreen when pressed', () => {
    const onFullscreen = vi.fn();
    const { container } = render(
      <ExploreHud {...base} onFullscreen={onFullscreen} isFullscreen={false} />,
    );
    const button = container.querySelector<HTMLButtonElement>('[aria-label="ملء الشاشة"]');
    button?.click();
    expect(onFullscreen).toHaveBeenCalledOnce();
  });
});
