import { useCallback, useEffect, useRef, useState } from 'react';

export type ToastTone = 'neutral' | 'success' | 'danger';

export interface ToastMessage {
  id: number;
  message: string;
  tone: ToastTone;
}

export function useToast(): {
  toast: ToastMessage | null;
  notify: (message: string, tone?: ToastTone) => void;
} {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const timer = useRef<number | null>(null);
  const counter = useRef(0);

  const notify = useCallback((message: string, tone: ToastTone = 'neutral') => {
    counter.current += 1;
    setToast({ id: counter.current, message, tone });
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 3800);
  }, []);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  return { toast, notify };
}
