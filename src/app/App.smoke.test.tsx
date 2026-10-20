// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App';

afterEach(cleanup);

function worldNameValue(): string {
  const input = screen.getByLabelText('World name') as HTMLInputElement;
  return input.value;
}

describe('application runtime', () => {
  it('boots, edits, adds assets, generates a world and undoes it', async () => {
    render(<App />);

    // Boot resolves from IndexedDB (fake in tests) and generates the starter world.
    await waitFor(() => expect(worldNameValue()).toBe('Welcome Meadow'), { timeout: 10000 });

    // Without WebGL the editor must degrade gracefully rather than crash.
    await waitFor(() => expect(screen.getByText(/3D viewport unavailable/i)).toBeTruthy(), {
      timeout: 8000,
    });

    // Object hierarchy reflects the generated starter world.
    fireEvent.click(screen.getByRole('tab', { name: /^Objects$/ }));
    expect(await screen.findByText(/objects in this world/i)).toBeTruthy();

    // Asset library adds a real object into the current plan.
    fireEvent.click(screen.getByRole('tab', { name: /^Assets$/ }));
    fireEvent.click(screen.getByRole('button', { name: /Pine tree/i }));
    expect(await screen.findByText(/Pine tree added to the world/i)).toBeTruthy();

    // AI panel generates a brand-new deterministic world.
    fireEvent.click(screen.getByRole('tab', { name: /^AI$/ }));
    const prompt = screen.getByLabelText('Description') as HTMLTextAreaElement;
    fireEvent.change(prompt, {
      target: { value: 'A desert oasis village at sunset with 18 palm trees' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Generate world/i }));

    expect(await screen.findByText(/Desert settlement/i, {}, { timeout: 10000 })).toBeTruthy();
    await waitFor(() => expect(worldNameValue().toLowerCase()).toContain('desert oasis'));

    // Undo restores the world that existed before generation.
    fireEvent.click(screen.getByRole('button', { name: /Undo \(Ctrl\/Cmd\+Z\)/i }));
    await waitFor(() => expect(worldNameValue()).toBe('Welcome Meadow'));

    // The local save pipeline reports success.
    expect(await screen.findByText(/Saved locally/i)).toBeTruthy();
  }, 30000);

  it('uses the mobile dock and bottom sheet at phone widths', async () => {
    const happyWindow = window as unknown as {
      happyDOM: { setViewport: (viewport: { width: number; height: number }) => void };
    };
    happyWindow.happyDOM.setViewport({ width: 390, height: 844 });

    render(<App />);
    await waitFor(
      () => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'),
      { timeout: 10000 },
    );

    const dock = await screen.findByRole('navigation', { name: 'Editor panels' });
    fireEvent.click(within(dock).getByRole('button', { name: /^Objects$/ }));

    const sheet = await screen.findByRole('dialog', { name: 'Objects' });
    expect(within(sheet).getByText(/objects in this world/i)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close panel' }));
    expect(screen.queryByRole('dialog', { name: 'Objects' })).toBeNull();
  }, 30000);
});
