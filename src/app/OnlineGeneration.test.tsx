// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('online generation interface', () => {
  it('requires a key and surfaces search citations without saving the key to the project', async () => {
    const plan = { biome: 'desert', timeOfDay: 'day', water: false, scale: 'small', style: 'stylized', density: 'normal',
      assets: [{ assetId: 'palm', count: 2, direction: null, target: null }], summary: 'نخلتان في الصحراء', limitations: [] };
    const fetchMock = vi.fn().mockImplementation(async (url: string) => url === '/api/session' ? new Response(JSON.stringify({ configured: false, signedIn: false, hasKey: false }), { headers: { 'Content-Type': 'application/json' } }) : new Response(JSON.stringify({ status: 'completed', output: [
      { type: 'web_search_call', status: 'completed' },
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(plan), annotations: [
        { type: 'url_citation', url: 'https://example.com/', title: 'مصدر' },
      ] }] },
    ] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'مكان في الصحراء' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    expect(screen.getByRole('alert').textContent).toContain('مفتاح');
    expect(fetchMock.mock.calls.some(([url]) => url === 'https://api.openai.com/v1/responses')).toBe(false);
    fireEvent.change(screen.getByLabelText('OpenAI API key'), { target: { value: 'test-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    expect(await screen.findByText('نخلتان في الصحراء')).toBeTruthy();
    expect(screen.getByText('تم استخدام البحث عبر الإنترنت في هذا الطلب.')).toBeTruthy();
    expect(screen.getByRole('link', { name: /مصدر/ }).getAttribute('href')).toBe('https://example.com/');
    expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toContain('test-key');
    fireEvent.click(screen.getByRole('tab', { name: 'World' }));
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }));
    expect((screen.getByLabelText('OpenAI API key') as HTMLInputElement).value).toBe('test-key');
  }, 20000);
  it('saves a key to the signed-in account and plans through the server proxy', async () => {
    let hasKey = false;
    const plan = { biome: 'meadow', timeOfDay: 'day', water: false, scale: 'small', style: 'stylized', density: 'normal',
      assets: [{ assetId: 'house', count: 1, direction: null, target: null }], summary: 'بيت صغير', limitations: [] };
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/session') return new Response(JSON.stringify({ configured: true, signedIn: true, hasKey, name: 'User', csrfToken: 'csrf-test' }), { headers: { 'Content-Type': 'application/json' } });
      if (url === '/api/account/key' && init?.method === 'PUT') { hasKey = true; return new Response('{}', { status: 200 }); }
      if (url === '/api/ai/plan') return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(plan) }] }] }), { status: 200 });
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await screen.findByText(/الحساب:/);
    fireEvent.change(screen.getByLabelText('OpenAI API key'), { target: { value: 'test-secret-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ في الحساب' }));
    await screen.findByText(/المفتاح محفوظ على الخادم/);
    expect((screen.getByLabelText('OpenAI API key') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'بيت صغير' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/ai/plan')).toBe(true));
    await waitFor(() => expect(document.querySelector('.ai-summary')?.textContent).toBe('بيت صغير'));
    const proxyCall = fetchMock.mock.calls.find(([url]) => url === '/api/ai/plan');
    expect(proxyCall).toBeTruthy();
    expect(JSON.stringify(proxyCall)).not.toContain('test-secret-key');
    expect((proxyCall![1]!.headers as Record<string, string>)['X-CSRF-Token']).toBe('csrf-test');
  }, 20000);

});
