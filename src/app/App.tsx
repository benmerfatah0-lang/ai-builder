import { createEmptyWorldPlan } from '../core/world-plan/factory';
import { EditorProvider } from '../modules/editor/store';
import { Workspace } from '../modules/editor/Workspace';

const INITIAL_PLAN = createEmptyWorldPlan({ name: 'Loading…' });

export default function App() {
  return (
    <EditorProvider initialPlan={INITIAL_PLAN}>
      <Workspace />
    </EditorProvider>
  );
}
