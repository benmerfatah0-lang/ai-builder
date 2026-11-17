// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

/**
 * The explore lifecycle has one job: leave no listeners or objects behind when
 * the player exits. This mirrors what GameMap does (create → dispose) without
 * needing WebGL.
 */

describe('explore lifecycle', () => {
  it('adds and removes every window listener it installs', async () => {
    const added: string[] = [];
    const removed: string[] = [];
    const realAdd = window.addEventListener.bind(window);
    const realRemove = window.removeEventListener.bind(window);
    const spyAdd = vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, opts) => {
      added.push(type);
      return realAdd(type, listener, opts);
    });
    const spyRemove = vi.spyOn(window, 'removeEventListener').mockImplementation((type, listener, opts) => {
      removed.push(type);
      return realRemove(type, listener, opts);
    });

    const { bindKeyboard } = await import('./explore');
    const intent = { forward: 0, strafe: 0, sprint: false, jump: false };
    const unbind = bindKeyboard(() => intent);
    expect(added).toContain('keydown');
    unbind();
    expect(removed).toContain('keydown');
    expect(removed).toContain('keyup');
    expect(removed).toContain('blur');

    spyAdd.mockRestore();
    spyRemove.mockRestore();
  });

  it('maps WASD and arrows into normalised intent', async () => {
    const { bindKeyboard } = await import('./explore');
    const intent = { forward: 0, strafe: 0, sprint: false, jump: false };
    const unbind = bindKeyboard(() => intent);

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    expect(intent.forward).toBe(1);
    expect(intent.strafe).toBe(0);

    // W + D must not be faster than W alone.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD' }));
    expect(Math.hypot(intent.forward, intent.strafe)).toBeCloseTo(1, 5);

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft' }));
    expect(intent.sprint).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
    expect(intent.jump).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD' }));
    expect(intent.forward).toBe(0);
    expect(intent.strafe).toBe(0);
    unbind();
  });

  it('leaves typing alone in an input field', async () => {
    const { bindKeyboard } = await import('./explore');
    const intent = { forward: 0, strafe: 0, sprint: false, jump: false };
    const unbind = bindKeyboard(() => intent);

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    expect(intent.forward).toBe(0);
    document.body.removeChild(input);
    unbind();
  });
});
