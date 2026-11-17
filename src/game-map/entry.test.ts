// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

/**
 * The one-click entry contract: the URL decides whether the visitor lands in
 * explore mode. If this drifts, every shared link silently breaks, so it is
 * worth pinning down separately from the component.
 */

const wantsExplore = (search: string, hash: string): boolean => {
  const params = new URLSearchParams(search);
  return params.has('explore') || hash === '#explore';
};

describe('explore entry links', () => {
  it('accepts ?explore', () => {
    expect(wantsExplore('?explore', '')).toBe(true);
  });

  it('accepts ?explore=1 and ?explore=true', () => {
    expect(wantsExplore('?explore=1', '')).toBe(true);
    expect(wantsExplore('?explore=true', '')).toBe(true);
  });

  it('accepts #explore', () => {
    expect(wantsExplore('', '#explore')).toBe(true);
  });

  it('ignores unrelated URLs', () => {
    expect(wantsExplore('', '')).toBe(false);
    expect(wantsExplore('?mode=paper', '')).toBe(false);
    expect(wantsExplore('', '#section-2')).toBe(false);
  });

  it('does not break when other params come first', () => {
    expect(wantsExplore('?lang=ar&explore&x=1', '')).toBe(true);
  });
});
