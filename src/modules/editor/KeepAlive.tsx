import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Keep a running operation mounted while removing its inactive UI from the document. */
export function KeepAlive({ active, children }: { active: boolean; children: ReactNode }) {
  const slot = useRef<HTMLDivElement>(null);
  const host = useMemo(() => {
    const element = document.createElement('div');
    element.style.display = 'contents';
    return element;
  }, []);
  useLayoutEffect(() => {
    if (active) slot.current?.appendChild(host);
    else host.remove();
    return () => { host.remove(); };
  }, [active, host]);
  return <><div ref={slot} style={{ display: 'contents' }} />{createPortal(children, host)}</>;
}
