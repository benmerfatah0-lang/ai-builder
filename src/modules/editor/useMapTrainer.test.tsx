// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMapTrainer } from './useMapTrainer';

afterEach(() => { cleanup(); vi.useRealTimers(); window.localStorage.clear(); });
describe('automatic map training lifecycle', () => {
  it('trains in the visible page, persists, pauses, resumes and resets', () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useMapTrainer());
    expect(result.current.model.attempts).toBe(0);
    act(() => vi.advanceTimersByTime(8000));
    expect(result.current.model.attempts).toBe(1);
    act(() => result.current.setEnabled(false));
    act(() => vi.advanceTimersByTime(100000));
    expect(result.current.model.attempts).toBe(1);
    act(() => result.current.setEnabled(true));
    act(() => vi.advanceTimersByTime(8000));
    expect(result.current.model.attempts).toBe(2);
    act(() => result.current.reset());
    expect(result.current.model.attempts).toBe(0);
    unmount();
    const next = renderHook(() => useMapTrainer());
    expect(next.result.current.model.attempts).toBe(0);
    next.unmount();
  });
  it('does not train when the page is hidden', () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const { result, unmount } = renderHook(() => useMapTrainer());
    act(() => vi.advanceTimersByTime(60000));
    expect(result.current.model.attempts).toBe(0);
    unmount(); spy.mockRestore();
  });
});
