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

  it('generates a farm, edits objects, regenerates, saves and reopens it', async () => {
    const unique = `Farm Acceptance ${Math.random().toString(36).slice(2, 7)}`;
    await bootDesktop();

    // ---- Prompt → plan → procedural farm ----------------------------------
    openTab('AI');
    const prompt = screen.getByLabelText('Description') as HTMLTextAreaElement;
    fireEvent.change(prompt, {
      target: {
        value:
          'Create a large cartoon low-poly farm with a farmhouse, barn, wheat fields, a chicken coop, fences, trees, and connected dirt paths',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /Generate world/i }));
    expect(await screen.findByText(/Farmstead · day/i, {}, { timeout: 15000 })).toBeTruthy();
    expect(await screen.findByText(/\d+ objects · \d+ groups · plan v3/i)).toBeTruthy();

    // The overview counts real objects, keyed by kind (regression: it used to
    // read `counts.trees`, which is never set, and always showed zero).
    const treesStat = screen.getByText('Trees').previousElementSibling;
    expect(Number(treesStat?.textContent)).toBeGreaterThan(10);
    const buildingsStat = screen.getByText('Buildings').previousElementSibling;
    expect(Number(buildingsStat?.textContent)).toBeGreaterThan(1);

    // Give the generated project a unique name for the library round-trip.
    const nameField = screen.getByLabelText('World name') as HTMLInputElement;
    fireEvent.change(nameField, { target: { value: unique } });
    fireEvent.blur(nameField);
    await waitFor(() =>
      expect((screen.getByLabelText('World name') as HTMLInputElement).value).toBe(unique),
    );

    openTab('Scene');
    const tree = await screen.findByRole('tree', { name: 'Scene hierarchy' });
    await waitFor(() => expect(tree.textContent).toContain('Barn'), { timeout: 8000 });
    expect(tree.textContent).toContain('Farmhouse');
    expect(tree.textContent).toContain('Chicken coop');
    expect(tree.textContent).toContain('Wheat field');

    // ---- Edit the farmhouse (position + rotation) -------------------------
    const farmhouse = within(tree)
      .getAllByRole('treeitem')
      .find((item) => (item.getAttribute('aria-label') ?? '').startsWith('Farmhouse'));
    if (!farmhouse) throw new Error('farmhouse not found');
    fireEvent.mouseDown(farmhouse.firstElementChild as HTMLElement);

    const positionX = await screen.findByLabelText('Position X');
    fireEvent.change(positionX, { target: { value: '-25' } });
    fireEvent.blur(positionX);
    const rotationY = screen.getByLabelText('Rotation Y');
    fireEvent.change(rotationY, { target: { value: '115' } });
    fireEvent.blur(rotationY);
    await waitFor(() =>
      expect((screen.getByLabelText('Position X') as HTMLInputElement).value).toBe('-25'),
    );

    // ---- Second edit: move and rescale the chicken coop -------------------
    const coop = within(screen.getByRole('tree', { name: 'Scene hierarchy' }))
      .getAllByRole('treeitem')
      .find((item) => (item.getAttribute('aria-label') ?? '').startsWith('Chicken coop'));
    if (!coop) throw new Error('coop not found');
    fireEvent.mouseDown(coop.firstElementChild as HTMLElement);
    const coopZ = await screen.findByLabelText('Position Z');
    fireEvent.change(coopZ, { target: { value: '30' } });
    fireEvent.blur(coopZ);
    const coopScale = screen.getByLabelText('Scale X');
    fireEvent.change(coopScale, { target: { value: '1.2' } });
    fireEvent.blur(coopScale);
    await waitFor(() =>
      expect((screen.getByLabelText('Position Z') as HTMLInputElement).value).toBe('30'),
    );

    // ---- Re-roll the barn's variation without moving it -------------------
    const barn = within(screen.getByRole('tree', { name: 'Scene hierarchy' }))
      .getAllByRole('treeitem')
      .find((item) => (item.getAttribute('aria-label') ?? '').startsWith('Barn'));
    if (!barn) throw new Error('barn not found');
    fireEvent.mouseDown(barn.firstElementChild as HTMLElement);

    // The inspector must report the real parent group, not silently fall back
    // to the first option ("World root").
    const parentSelect = await screen.findByLabelText('Parent');
    await waitFor(() => expect((parentSelect as HTMLSelectElement).value).not.toBe('__root__'));
    expect(
      (parentSelect as HTMLSelectElement).selectedOptions[0]?.textContent,
    ).toBe('Farmstead');

    fireEvent.click(await screen.findByRole('button', { name: 'Generated' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Regenerate$/ }));
    expect(await screen.findByText(/Regenerated “Barn”/i)).toBeTruthy();

    // ---- Save, reopen, verify the edited world survived -------------------
    fireEvent.click(screen.getByRole('button', { name: /Save now \(Ctrl\/Cmd\+S\)/ }));
    expect(await screen.findByText(/Project saved in this browser/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Project menu' }));
    fireEvent.click(await screen.findByRole('button', { name: /World library/i }));
    const dialog = await screen.findByRole('dialog', { name: 'World library' });
    fireEvent.click(
      await within(dialog).findByRole(
        'button',
        { name: `Open ${unique}` },
        { timeout: 8000 },
      ),
    );

    await waitFor(
      () => expect((screen.getByLabelText('World name') as HTMLInputElement).value).toBe(unique),
      { timeout: 8000 },
    );

    openTab('Scene');
    const reopened = await screen.findByRole('tree', { name: 'Scene hierarchy' });
    await waitFor(() => expect(reopened.textContent).toContain('Barn'), { timeout: 8000 });
    const reopenedFarmhouse = within(reopened)
      .getAllByRole('treeitem')
      .find((item) => (item.getAttribute('aria-label') ?? '').startsWith('Farmhouse'));
    if (!reopenedFarmhouse) throw new Error('farmhouse missing after reopen');
    fireEvent.mouseDown(reopenedFarmhouse.firstElementChild as HTMLElement);
    await waitFor(() =>
      expect((screen.getByLabelText('Position X') as HTMLInputElement).value).toBe('-25'),
    );
    expect((screen.getByLabelText('Rotation Y') as HTMLInputElement).value).toBe('115');

    // The second edited object kept its new position and scale too.
    const reopenedCoop = within(screen.getByRole('tree', { name: 'Scene hierarchy' }))
      .getAllByRole('treeitem')
      .find((item) => (item.getAttribute('aria-label') ?? '').startsWith('Chicken coop'));
    if (!reopenedCoop) throw new Error('coop missing after reopen');
    fireEvent.mouseDown(reopenedCoop.firstElementChild as HTMLElement);
    await waitFor(() =>
      expect((screen.getByLabelText('Position Z') as HTMLInputElement).value).toBe('30'),
    );
    expect((screen.getByLabelText('Scale X') as HTMLInputElement).value).toBe('1.2');
    expect(screen.getByRole('tree', { name: 'Scene hierarchy' }).textContent).toContain('Wheat');
  }, 60000);

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
