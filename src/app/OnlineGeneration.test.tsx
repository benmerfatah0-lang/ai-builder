// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('OpenAI interface', () => {
  it('requires a key and shows search citations', async () => {
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
    expect(screen.getByRole('link', { name: 'مصدر ↗' }).getAttribute('href')).toBe('https://example.com/');
    expect(fetchMock.mock.calls[0]![0]).toContain('api.openai.com');
    expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toContain('test-key');
    fireEvent.click(screen.getByRole('tab', { name: 'World' }));
    fireEvent.click(screen.getByRole('tab', { name: 'AI' }));
    expect((screen.getByLabelText('OpenAI API key') as HTMLInputElement).value).toBe('test-key');
  }, 20000);
  it('saves an encrypted key, reopens it with a password, and removes it', async () => {
    vi.stubGlobal('crypto', webcrypto);
    localStorage.clear();
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('OpenAI API key'), { target: { value: 'my-private-openai-key' } });
    fireEvent.change(screen.getByLabelText('كلمة مرور حفظ المفتاح'), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ مشفّر' }));
    await screen.findByRole('button', { name: 'فتح المفتاح' });
    expect(localStorage.getItem('worldbuilder.openai-vault.v1')).not.toContain('my-private-openai-key');
    expect((screen.getByLabelText('كلمة مرور حفظ المفتاح') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('OpenAI API key'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('كلمة مرور حفظ المفتاح'), { target: { value: 'wrong password' } });
    fireEvent.click(screen.getByRole('button', { name: 'فتح المفتاح' }));
    expect((await screen.findByRole('alert')).textContent).toContain('كلمة المرور');
    fireEvent.change(screen.getByLabelText('كلمة مرور حفظ المفتاح'), { target: { value: 'password123' } });
    await waitFor(() => expect((screen.getByRole('button', { name: 'فتح المفتاح' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'فتح المفتاح' }));
    await waitFor(() => expect((screen.getByLabelText('OpenAI API key') as HTMLInputElement).value).toBe('my-private-openai-key'));
    await waitFor(() => expect((screen.getByRole('button', { name: 'حذف المفتاح' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'حذف المفتاح' }));
    expect(localStorage.getItem('worldbuilder.openai-vault.v1')).toBeNull();
    expect((screen.getByLabelText('OpenAI API key') as HTMLInputElement).value).toBe('');
  }, 20000);

});
