import { useCallback, useEffect, useState } from 'react';

export type AccountState =
  | { status: 'loading' | 'unavailable' | 'unconfigured' | 'signedOut' }
  | { status: 'signedIn'; name: string; hasKey: boolean; csrfToken: string };

/** Google session state and CSRF token only; API keys are never read back. */
export function useAccount() {
  const [account, setAccount] = useState<AccountState>({ status: 'loading' });
  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) throw new Error('unavailable');
      const data: unknown = await res.json();
      if (!data || typeof data !== 'object') throw new Error('invalid');
      const item = data as Record<string, unknown>;
      if (item.configured === false) setAccount({ status: 'unconfigured' });
      else if (item.configured === true && item.signedIn === false) setAccount({ status: 'signedOut' });
      else if (item.configured === true && item.signedIn === true && typeof item.csrfToken === 'string' && typeof item.hasKey === 'boolean') {
        setAccount({ status: 'signedIn', name: typeof item.name === 'string' ? item.name : 'Google', hasKey: item.hasKey, csrfToken: item.csrfToken });
      } else throw new Error('invalid');
    } catch { setAccount({ status: 'unavailable' }); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const change = useCallback(async (method: 'PUT' | 'DELETE' | 'POST', path: string, key?: string) => {
    if (account.status !== 'signedIn') throw new Error('سجّل الدخول بحساب Google أولاً.');
    const response = await fetch(path, {
      method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': account.csrfToken },
      ...(key === undefined ? {} : { body: JSON.stringify({ apiKey: key }) }),
    });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403
      ? 'انتهت الجلسة أو تعذّر التحقق منها. أعد تسجيل الدخول.'
      : 'تعذّر تحديث الحساب. تحقّق من الخادم أو المفتاح وحاول مجدداً.');
    await refresh();
  }, [account, refresh]);
  return { account, saveKey: (key: string) => change('PUT', '/api/account/key', key),
    deleteKey: () => change('DELETE', '/api/account/key'), logout: () => change('POST', '/api/auth/logout') };
}
