import { useCallback, useEffect, useRef, useState } from 'react';
import { initialMapTraining, loadMapTraining, removeMapTraining, saveMapTraining, trainMapStep } from '../ai/mapTrainer';

/** One small trial every 45 seconds while visible; never run in a closed/background tab. */
export function useMapTrainer() {
  const [model, setModel] = useState(() => {
    try { return loadMapTraining(window.localStorage); } catch { return initialMapTraining(); }
  });
  const current = useRef(model);
  const [error, setError] = useState('');
  const update = useCallback((next: typeof model) => { current.current = next; setModel(next); }, []);

  useEffect(() => {
    if (!model.enabled) return;
    let timer: ReturnType<typeof setTimeout>;
    let active = true;
    const run = () => {
      if (!active) return;
      if (document.visibilityState === 'visible' && current.current.enabled) {
        try {
          const next = trainMapStep(current.current);
          saveMapTraining(window.localStorage, next);
          update(next);
          setError('');
        } catch {
          update({ ...current.current, enabled: false });
          setError('توقف التدريب لتعذّر حفظ نتائجه أو إكمال التجربة.');
          return;
        }
      }
      timer = setTimeout(run, 45000);
    };
    timer = setTimeout(run, 8000);
    return () => { active = false; clearTimeout(timer); };
  }, [model.enabled, update]);

  const setEnabled = useCallback((enabled: boolean) => {
    const next = { ...current.current, enabled };
    try { saveMapTraining(window.localStorage, next); update(next); setError(''); }
    catch { setError('تعذّر حفظ إعداد التدريب في المتصفح.'); }
  }, [update]);
  const reset = useCallback(() => {
    try { removeMapTraining(window.localStorage); const next = { ...initialMapTraining(), enabled: current.current.enabled };
      saveMapTraining(window.localStorage, next); update(next); setError(''); }
    catch { setError('تعذّر حذف بيانات التدريب من المتصفح.'); }
  }, [update]);
  return { model, setEnabled, reset, error };
}
export type MapTrainer = ReturnType<typeof useMapTrainer>;
