// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('online generation interface', () => {
  it('requires a key and surfaces search citations without saving the key to the project', async () => {
    const plan = { biome: 'desert', timeOfDay: 'day', water: false, scale: 'small', style: 'stylized', density: 'normal',
      assets: [{ assetId: 'palm', count: 2, direction: null, target: null }], summary: 'نخلتان في الصحراء', limitations: [] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'completed', output: [
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
    expect(fetchMock).not.toHaveBeenCalled();
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
});
