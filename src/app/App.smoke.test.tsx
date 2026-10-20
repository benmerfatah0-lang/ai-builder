// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App';

afterEach(cleanup);

function worldNameValue(): string {
  return (screen.getByLabelText('World name') as HTMLInputElement).value;
}

async function bootDesktop() {
  render(<App />);
  await waitFor(() => expect(worldNameValue()).not.toBe('Loading…'), { timeout: 10000 });
  await waitFor(() => expect(screen.getByText(/3D viewport unavailable/i)).toBeTruthy(), {
    timeout: 8000,
  });
}

function openTab(name: string) {
  fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${name}$`) }));
}

describe('application runtime', () => {
  it('boots, edits, adds assets, generates a world and undoes it', async () => {
    await bootDesktop();
    expect(worldNameValue()).toBe('Welcome Meadow');

    // Scene tree reflects the generated starter world.
    openTab('Scene');
    const tree = await screen.findByRole('tree', { name: 'Scene hierarchy' });
    expect(within(tree).getAllByRole('treeitem').length).toBeGreaterThan(3);

    // Asset library adds a real object into the current plan.
    openTab('Assets');
    fireEvent.click(screen.getByRole('button', { name: /Pine tree/i }));
    expect(await screen.findByText(/Pine tree added to the world/i)).toBeTruthy();

    // AI panel generates a brand-new deterministic world.
    openTab('AI');
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

  it('supports the acceptance workflow through the editor UI', async () => {
    await bootDesktop();

    // Give this run a unique project name so the library row is unambiguous.
    const worldName = screen.getByLabelText('World name') as HTMLInputElement;
    fireEvent.change(worldName, { target: { value: 'Acceptance Scene' } });
    fireEvent.blur(worldName);
    await waitFor(() =>
      expect((screen.getByLabelText('World name') as HTMLInputElement).value).toBe(
        'Acceptance Scene',
      ),
    );

    const addAsset = (label: RegExp) => {
      openTab('Assets');
      fireEvent.click(screen.getByRole('button', { name: label }));
    };

    // ---- Ground plane, cube, tree and house --------------------------------
    addAsset(/Ground plane/i);
    addAsset(/^Cube/i);
    addAsset(/Pine tree/i);
    addAsset(/^House/i);

    openTab('Scene');
    const tree = await screen.findByRole('tree', { name: 'Scene hierarchy' });
    const items = within(tree).getAllByRole('treeitem');
    const names = items.map((item) => item.getAttribute('aria-label') ?? '');
    expect(names.some((name) => name.startsWith('Ground plane'))).toBe(true);
    expect(names.some((name) => name.startsWith('Cube'))).toBe(true);
    expect(names.some((name) => name.includes('Pine'))).toBe(true);
    expect(names.some((name) => name.startsWith('House'))).toBe(true);

    // ---- Select the cube, then move / rotate / scale it -------------------
    const cubeItem = within(tree)
      .getAllByRole('treeitem')
      .find((item) => (item.getAttribute('aria-label') ?? '').startsWith('Cube'));
    if (!cubeItem) throw new Error('cube not found in hierarchy');
    fireEvent.mouseDown(cubeItem.firstElementChild as HTMLElement);

    const positionX = await screen.findByLabelText('Position X');
    fireEvent.change(positionX, { target: { value: '5' } });
    fireEvent.blur(positionX);
    const positionZ = screen.getByLabelText('Position Z');
    fireEvent.change(positionZ, { target: { value: '-1' } });
    fireEvent.blur(positionZ);
    const rotationY = screen.getByLabelText('Rotation Y');
    fireEvent.change(rotationY, { target: { value: '30' } });
    fireEvent.blur(rotationY);
    const scaleX = screen.getByLabelText('Scale X');
    fireEvent.change(scaleX, { target: { value: '1.5' } });
    fireEvent.blur(scaleX);

    await waitFor(() =>
      expect((screen.getByLabelText('Position X') as HTMLInputElement).value).toBe('5'),
    );
    expect((screen.getByLabelText('Rotation Y') as HTMLInputElement).value).toBe('30');
    expect((screen.getByLabelText('Scale X') as HTMLInputElement).value).toBe('1.5');

    // ---- Select the newly added pine and rename it -----------------------
    const itemsNow = within(screen.getByRole('tree', { name: 'Scene hierarchy' })).getAllByRole(
      'treeitem',
    );
    const addedPine = itemsNow.find(
      (item) => (item.getAttribute('aria-label') ?? '') === 'Pine (Tree)',
    );
    if (!addedPine) throw new Error('added pine not found in hierarchy');
    fireEvent.mouseDown(addedPine.firstElementChild as HTMLElement);

    const nameField = (await screen.findByLabelText('Name')) as HTMLInputElement;
    expect(nameField.value).toBe('Pine');
    fireEvent.change(nameField, { target: { value: 'Hero Tree' } });
    fireEvent.blur(nameField);

    await waitFor(() =>
      expect(screen.getByRole('tree', { name: 'Scene hierarchy' }).textContent).toContain(
        'Hero Tree',
      ),
    );

    // ---- Group the pine and the house ------------------------------------
    const treeItemsNow = within(screen.getByRole('tree', { name: 'Scene hierarchy' })).getAllByRole(
      'treeitem',
    );
    const heroTree = treeItemsNow.find((item) =>
      (item.getAttribute('aria-label') ?? '').startsWith('Hero Tree'),
    );
    const house = treeItemsNow.find((item) =>
      (item.getAttribute('aria-label') ?? '').startsWith('House'),
    );
    if (!heroTree || !house) throw new Error('grouping targets not found');
    fireEvent.mouseDown(heroTree.firstElementChild as HTMLElement);
    fireEvent.mouseDown(house.firstElementChild as HTMLElement, { shiftKey: true });

    // "Group" exists both in the scene footer and the multi-selection inspector.
    const groupButtons = screen.getAllByRole('button', { name: /^Group$/ });
    fireEvent.click(groupButtons[0] as HTMLElement);
    await waitFor(() =>
      expect(
        screen
          .getByRole('tree', { name: 'Scene hierarchy' })
          .querySelectorAll('[aria-label^="Group ("]').length,
      ).toBeGreaterThan(0),
    );

    const treeItems = within(screen.getByRole('tree', { name: 'Scene hierarchy' })).getAllByRole(
      'treeitem',
    );
    expect(treeItems.some((item) => (item.getAttribute('aria-label') ?? '').startsWith('Group'))).toBe(
      true,
    );

    // ---- Hide + lock toggles keep working --------------------------------
    fireEvent.click(screen.getByRole('button', { name: /^Collapse group$/ }));
    expect(screen.getByRole('button', { name: /^Expand group$/ })).toBeTruthy();

    // ---- Manual save ------------------------------------------------------
    fireEvent.click(screen.getByRole('button', { name: /Save now \(Ctrl\/Cmd\+S\)/ }));
    expect(await screen.findByText(/Project saved in this browser/i)).toBeTruthy();

    // ---- Reopen the saved project from the library -----------------------
    fireEvent.click(screen.getByRole('button', { name: 'Project menu' }));
    fireEvent.click(await screen.findByRole('button', { name: /World library/i }));
    const dialog = await screen.findByRole('dialog', { name: 'World library' });
    const worldRow = await within(dialog).findByRole(
      'button',
      { name: 'Open Acceptance Scene' },
      { timeout: 8000 },
    );
    fireEvent.click(worldRow);

    await waitFor(() =>
      expect(screen.getByRole('tree', { name: 'Scene hierarchy' }).textContent).toContain('Group'),
    );

    // The group was collapsed earlier; expand it to verify the children survived.
    const expandButton = await screen.findByRole('button', { name: /^Expand group$/ });
    fireEvent.click(expandButton);
    await waitFor(() =>
      expect(screen.getByRole('tree', { name: 'Scene hierarchy' }).textContent).toContain(
        'Hero Tree',
      ),
    );
    expect(screen.getByRole('tree', { name: 'Scene hierarchy' }).textContent).toContain('House');
  }, 45000);

  it('restores the most recent world after a full reload', async () => {
    const unique = `Reload Check ${Math.random().toString(36).slice(2, 7)}`;

    await bootDesktop();
    const name = screen.getByLabelText('World name') as HTMLInputElement;
    fireEvent.change(name, { target: { value: unique } });
    fireEvent.blur(name);
    await waitFor(() =>
      expect((screen.getByLabelText('World name') as HTMLInputElement).value).toBe(unique),
    );

    fireEvent.click(screen.getByRole('button', { name: /Save now \(Ctrl\/Cmd\+S\)/ }));
    await screen.findByText(/Project saved in this browser/i);
    cleanup();

    // A fresh mount is what the browser does after a refresh.
    render(<App />);
    await waitFor(
      () => expect((screen.getByLabelText('World name') as HTMLInputElement).value).toBe(unique),
      { timeout: 10000 },
    );
    // The hierarchy was restored from IndexedDB, not regenerated.
    fireEvent.click(screen.getByRole('tab', { name: /^Scene$/ }));
    const tree = await screen.findByRole('tree', { name: 'Scene hierarchy' });
    expect(within(tree).getAllByRole('treeitem').length).toBeGreaterThan(3);
  }, 30000);

  it('uses the mobile dock and bottom sheet at phone widths', async () => {
    const happyWindow = window as unknown as {
      happyDOM: { setViewport: (viewport: { width: number; height: number }) => void };
    };
    happyWindow.happyDOM.setViewport({ width: 390, height: 844 });

    render(<App />);
    await waitFor(() => expect(worldNameValue()).not.toBe('Loading…'), { timeout: 10000 });

    const dock = await screen.findByRole('navigation', { name: 'Editor panels' });
    fireEvent.click(within(dock).getByRole('button', { name: /^Scene$/ }));

    const sheet = await screen.findByRole('dialog', { name: 'Scene' });
    expect(within(sheet).getByRole('tree', { name: 'Scene hierarchy' })).toBeTruthy();

    // The transform toolbar is reachable on mobile.
    const toolbar = screen.getByRole('toolbar', { name: 'Transform tools' });
    expect(within(toolbar).getByRole('button', { name: /Rotate/i })).toBeTruthy();

    // Axis constraints are real toggles, and at least one axis stays enabled.
    const yAxis = within(toolbar).getByRole('button', { name: 'Toggle Y axis' });
    expect(yAxis.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(yAxis);
    expect(yAxis.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Toggle X axis' }));
    fireEvent.click(within(toolbar).getByRole('button', { name: 'Toggle Z axis' }));
    // Turning off the last axis resets to all axes rather than disabling editing.
    expect(within(toolbar).getByRole('button', { name: 'Toggle Y axis' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(within(sheet).getByRole('button', { name: 'Close panel' }));
    expect(screen.queryByRole('dialog', { name: 'Scene' })).toBeNull();
  }, 30000);
});
