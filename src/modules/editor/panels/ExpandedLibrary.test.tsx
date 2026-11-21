// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EditorProvider, useEditor } from '../store';
import { createEmptyWorldPlan } from '../../../core/world-plan/factory';
import { AssetsPanel } from './AssetsPanel';
import { WorldPanel } from './WorldPanel';

function Observer() {
  const {state, dispatch}=useEditor();
  return <><output data-testid="world">{JSON.stringify(state.plan)}</output><button onClick={()=>dispatch({type:'undo'})}>test undo</button></>;
}
afterEach(cleanup);
describe('expanded library controls', () => {
  it('searches Arabic, filters props, places an editable object and undoes it', () => {
    const initial=createEmptyWorldPlan({seed:123});
    render(<EditorProvider initialPlan={initial}><AssetsPanel notify={vi.fn()}/><Observer/></EditorProvider>);
    fireEvent.change(screen.getByLabelText('البحث عن العناصر'), {target:{value:'البرميل'}});
    fireEvent.click(screen.getByRole('button',{name:/^Barrel/}));
    let plan=JSON.parse(screen.getByTestId('world').textContent!);
    expect(plan.objects).toHaveLength(1);
    expect(plan.objects[0].primitive).toBe('barrel');
    fireEvent.click(screen.getByRole('button',{name:'test undo'}));
    plan=JSON.parse(screen.getByTestId('world').textContent!);expect(plan.objects).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('البحث عن العناصر'), {target:{value:''}});
    fireEvent.click(screen.getByRole('button',{name:'أغراض'}));
    expect(screen.getByRole('button',{name:/^Bench/})).toBeTruthy();
    expect(screen.queryByRole('button',{name:/^Castle/})).toBeNull();
  });
  it('selects a new terrain, preserves the old objects and can undo', () => {
    const initial=createEmptyWorldPlan({seed:123});
    render(<EditorProvider initialPlan={initial}><WorldPanel storageKind="memory" onOpenLibrary={()=>{}}/><Observer/></EditorProvider>);
    fireEvent.change(screen.getByLabelText('Landform'), {target:{value:'volcano'}});
    let plan=JSON.parse(screen.getByTestId('world').textContent!);
    expect(plan.terrain.style).toBe('volcano');expect(plan.objects).toEqual(initial.objects);
    fireEvent.click(screen.getByRole('button',{name:'test undo'}));
    plan=JSON.parse(screen.getByTestId('world').textContent!);expect(plan.terrain.style).toBe(initial.terrain.style);
  });
});
