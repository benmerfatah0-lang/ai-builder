// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });
function groqResponse(value: unknown) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }));
}
describe('Groq and Tavily interface', () => {
  it('requires both keys, performs online search and displays the source', async () => {
    const plan = { biome: 'desert', timeOfDay: 'day', water: false, scale: 'small', style: 'stylized', density: 'normal',
      assets: [{ assetId: 'palm', count: 2, direction: null, target: null }], summary: 'نخلتان في الصحراء', limitations: [] };
    const fetchMock = vi.fn().mockResolvedValueOnce(groqResponse({ query: 'desert' }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ url: 'https://example.com/', title: 'مصدر', content: 'نخلة' }] })))
      .mockResolvedValueOnce(groqResponse(plan));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'مكان في الصحراء' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    expect(screen.getByRole('alert').textContent).toContain('مفتاح');
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Groq API key'), { target: { value: 'test-groq-key' } });
    fireEvent.change(screen.getByLabelText('Tavily API key'), { target: { value: 'test-tavily-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    expect(await screen.findByText('نخلتان في الصحراء')).toBeTruthy();
    expect(screen.getByText('تم استخدام البحث عبر الإنترنت في هذا الطلب.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'مصدر ↗' }).getAttribute('href')).toBe('https://example.com/');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/groq');
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/tavily');
    expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toContain('test-groq-key');
    fireEvent.click(screen.getByRole('tab', { name: 'World' }));
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }));
    expect((screen.getByLabelText('Groq API key') as HTMLInputElement).value).toBe('test-groq-key');
  }, 20000);
  it('saves two encrypted keys, unlocks and removes them', async () => {
    vi.stubGlobal('crypto', webcrypto);
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Groq API key'), { target: { value: 'my-private-groq-key' } });
    fireEvent.change(screen.getByLabelText('Tavily API key'), { target: { value: 'my-private-tavily-key' } });
    fireEvent.change(screen.getByLabelText('كلمة مرور حفظ المفتاح'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ مشفّر' }));
    await screen.findByRole('button', { name: 'فتح المفتاحين' });
    const encrypted = localStorage.getItem('worldbuilder.groq-tavily-vault.v1');
    expect(encrypted).not.toContain('my-private-groq-key');
    expect(encrypted).not.toContain('my-private-tavily-key');
    expect((screen.getByLabelText('كلمة مرور حفظ المفتاح') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('Groq API key'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Tavily API key'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('كلمة مرور حفظ المفتاح'), { target: { value: 'wrong password' } });
    fireEvent.click(screen.getByRole('button', { name: 'فتح المفتاحين' }));
    expect((await screen.findByRole('alert')).textContent).toContain('كلمة المرور');
    fireEvent.change(screen.getByLabelText('كلمة مرور حفظ المفتاح'), { target: { value: 'password123' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'فتح المفتاحين' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'فتح المفتاحين' }));
    await waitFor(() => expect((screen.getByLabelText('Groq API key') as HTMLInputElement).value).toBe('my-private-groq-key'));
    expect((screen.getByLabelText('Tavily API key') as HTMLInputElement).value).toBe('my-private-tavily-key');
    await waitFor(() => expect((screen.getByRole('button', { name: 'حذف المفتاحين' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'حذف المفتاحين' }));
    expect(localStorage.getItem('worldbuilder.groq-tavily-vault.v1')).toBeNull();
    expect((screen.getByLabelText('Groq API key') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Tavily API key') as HTMLInputElement).value).toBe('');
  }, 20000);
});
