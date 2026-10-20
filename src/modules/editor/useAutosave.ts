import { useEffect, useRef } from 'react';
import type { Dispatch } from 'react';
import type { WorldRepository } from '../../core/persistence/worldRepository';
import type { EditorAction, EditorState } from './store';

/**
 * Debounced local autosave. Every plan mutation bumps `revision`; once paused,
 * the whole validated plan is written to IndexedDB. No network involved.
 */
export function useAutosave(
  state: EditorState,
  dispatch: Dispatch<EditorAction>,
  repository: WorldRepository,
  enabled: boolean,
): void {
  const savedRevision = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    // The first enabled render always saves: this persists a freshly generated
    // starter world and re-saves a loaded one (harmless, same document).
    if (state.revision === savedRevision.current) return;

    const revision = state.revision;
    const plan = state.plan;

    const timer = window.setTimeout(async () => {
      dispatch({ type: 'setSaveState', status: 'saving' });
      try {
        await repository.save(plan);
        savedRevision.current = revision;
        // Only report "saved" if no newer edit arrived while writing.
        dispatch({ type: 'setSaveState', status: 'saved' });
      } catch (error) {
        dispatch({
          type: 'setSaveState',
          status: 'error',
          error: error instanceof Error ? error.message : 'Could not save this world locally.',
        });
      }
    }, 650);

    return () => window.clearTimeout(timer);
  }, [state.revision, state.plan, dispatch, repository, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (
        state.saveState === 'pending' ||
        state.saveState === 'saving' ||
        state.saveState === 'error'
      ) {
        event.preventDefault();
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [state.saveState, enabled]);
}
