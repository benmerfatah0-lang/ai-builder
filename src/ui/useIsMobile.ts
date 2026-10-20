import { useEffect, useState } from 'react';

export const MOBILE_QUERY = '(max-width: 980px)';

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(MOBILE_QUERY).matches,
  );

  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY);
    const listener = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    query.addEventListener('change', listener);
    setIsMobile(query.matches);
    return () => query.removeEventListener('change', listener);
  }, []);

  return isMobile;
}
