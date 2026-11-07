// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); });
describe('lightweight local planning interface', () => {
  it('generates without a model server and shows Wikipedia sources when requested', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{"online":true}'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ url: 'https://ar.wikipedia.org/wiki/صحراء', title: 'مصدر', content: 'صحراء' }] })));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'بيت في الصحراء' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'ابحث في ويكيبيديا عن هذا الوصف' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    expect(await screen.findByText('تم البحث في ويكيبيديا في هذا الطلب.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'مصدر ↗' }).getAttribute('href')).toContain('ar.wikipedia.org/wiki/');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/online', '/api/search']);
  }, 20000);
  it('shows an internet error without silently generating offline', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 502 })); vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'بيت' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    expect((await screen.findByRole('alert')).textContent).toContain('ويكيبيديا');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, 20000);
  it('learns an explicitly selected house and can delete personal training', async () => {
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.click(screen.getByRole('tab', { name: /^Assets$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^House/i }));
    fireEvent.click(screen.getByRole('tab', { name: /^AI$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'تعلّم من العنصر المحدد' }));
    expect(screen.getByText(/تم التدريب على أبعاد العنصر المحدد/)).toBeTruthy();
    expect(screen.getByText(/الأمثلة الشخصية: 1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'حذف التدريب الشخصي' }));
    expect(screen.getByText(/الأمثلة الشخصية: 0/)).toBeTruthy();
  }, 20000);
});
