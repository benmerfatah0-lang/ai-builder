// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function modelResponse(value: unknown) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }));
}
describe('local model and Wikipedia interface', () => {
  it('uses the local model and displays Wikipedia sources', async () => {
    const plan = { biome: 'desert', timeOfDay: 'day', water: false, scale: 'small', style: 'stylized', density: 'normal',
      assets: [{ assetId: 'palm', count: 2, direction: null, target: null }], summary: 'نخلتان في الصحراء', limitations: [] };
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{"online":true}'))
      .mockResolvedValueOnce(modelResponse({ query: 'صحراء' }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ url: 'https://ar.wikipedia.org/wiki/صحراء', title: 'مصدر', content: 'نخلة' }] })))
      .mockResolvedValueOnce(modelResponse(plan));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'مكان في الصحراء' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    expect(await screen.findByText('نخلتان في الصحراء')).toBeTruthy();
    expect(screen.getByText('تم البحث في ويكيبيديا في هذا الطلب.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'مصدر ↗' }).getAttribute('href')).toContain('ar.wikipedia.org/wiki/');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/online', '/api/model', '/api/search', '/api/model']);
    expect(screen.queryByLabelText('Groq API key')).toBeNull();
    expect(screen.queryByLabelText('Tavily API key')).toBeNull();
  }, 20000);
  it('shows an internet error without silently generating offline', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'مكان' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    expect((await screen.findByRole('alert')).textContent).toContain('ويكيبيديا');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, 20000);
});
