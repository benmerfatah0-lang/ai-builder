// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); });
describe('lightweight local planning interface', () => {
  it('generates without a model server and shows Wikipedia sources when requested', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{"online":true}'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 1, cursor: 0, status: 'starting', classes: { desert: {docs:0,tokens:{}}, forest: {docs:0,tokens:{}}, mountains: {docs:0,tokens:{}}, island: {docs:0,tokens:{}} }, sources: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 1, cursor: 0, status: 'starting', samples: 0, last_loss: null, sources: [], profiles: Object.fromEntries(['default', 'small', 'tall', 'wide'].map(key => [key, {count: 0, mean: [1, 1, 1, 1]}])) })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{ url: 'https://ar.wikipedia.org/wiki/صحراء', title: 'مصدر', content: 'صحراء' }] })));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'بيت في الصحراء' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'ابحث في ويكيبيديا عن هذا الوصف' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    expect(await screen.findByText('تم البحث في ويكيبيديا في هذا الطلب.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'مصدر ↗' }).getAttribute('href')).toContain('ar.wikipedia.org/wiki/');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/online', '/api/knowledge', '/api/house-learning', '/api/search']);
  }, 20000);
  it('creates a named world from the Forge home and opens the existing 3D editor', async () => {
    const responses = [new Response('{"online":true}'), new Response(JSON.stringify({ version: 1, cursor: 0, status: 'starting', classes: { desert: {docs:0,tokens:{}}, forest: {docs:0,tokens:{}}, mountains: {docs:0,tokens:{}}, island: {docs:0,tokens:{}} }, sources: [] })), new Response(JSON.stringify({ version: 1, cursor: 0, status: 'starting', samples: 0, last_loss: null, sources: [], profiles: Object.fromEntries(['default', 'small', 'tall', 'wide'].map(key => [key, {count: 0, mean: [1, 1, 1, 1]}])) }))];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(responses[0]).mockResolvedValueOnce(responses[1]).mockResolvedValueOnce(responses[2]));
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    expect(screen.getByRole('heading', { name: 'اصنع عالمك من الخيال' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'بيت وشجرة' } });
    fireEvent.change(screen.getByLabelText('اسم العالم (اختياري)'), { target: { value: 'عالمي الجديد' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    fireEvent.click(await screen.findByRole('button', { name: 'فتح العالم في المحرر ←' }));
    expect((screen.getByLabelText('World name') as HTMLInputElement).value).toBe('عالمي الجديد');
    expect(screen.getByRole('region', { name: '3D viewport' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Grimoire/ }));
    expect(await screen.findByRole('dialog', { name: 'World library' })).toBeTruthy();
  }, 20000);
  it('opens the library and editor from the Forge navigation at phone width', async () => {
    const browser = window as unknown as { happyDOM: { setViewport: (viewport: { width: number; height: number }) => void } };
    browser.happyDOM.setViewport({ width: 390, height: 844 });
    try {
      render(<App />);
      await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
      expect(screen.getByRole('heading', { name: 'اصنع عالمك من الخيال' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /Grimoire/ }));
      expect(await screen.findByRole('dialog', { name: 'World library' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Close library' }));
      fireEvent.click(screen.getByRole('button', { name: /Builder/ }));
      expect(await screen.findByRole('navigation', { name: 'Editor panels' })).toBeTruthy();
      expect(within(screen.getByRole('dialog', { name: 'AI world' })).getByLabelText('تعديل العالم بالكتابة')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /Forge/ }));
      expect(screen.getByLabelText('Description')).toBeTruthy();
    } finally { browser.happyDOM.setViewport({ width: 1024, height: 768 }); }
  }, 20000);
  it('edits the generated world by text and undo restores it', async () => {
    const data = [new Response('{"online":true}'), new Response(JSON.stringify({ version: 1, cursor: 0, status: 'starting', classes: { desert: {docs:0,tokens:{}}, forest: {docs:0,tokens:{}}, mountains: {docs:0,tokens:{}}, island: {docs:0,tokens:{}} }, sources: [] })), new Response(JSON.stringify({ version: 1, cursor: 0, status: 'starting', samples: 0, last_loss: null, sources: [], profiles: Object.fromEntries(['default', 'small', 'tall', 'wide'].map(key => [key, {count: 0, mean: [1, 1, 1, 1]}])) }))];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(data[0]).mockResolvedValueOnce(data[1]).mockResolvedValueOnce(data[2]));
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'بيت' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    fireEvent.click(await screen.findByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), { target: { value: 'أضف شجرتين على يمين البيت' } });
    fireEvent.click(screen.getByRole('button', { name: 'تطبيق التعديل' }));
    expect(await screen.findByText(/أُضيف 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /^Scene$/ }));
    const tree = screen.getByRole('tree', { name: 'Scene hierarchy' });
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: /Undo \(Ctrl\/Cmd\+Z\)/ }));
    expect(within(screen.getByRole('tree', { name: 'Scene hierarchy' })).getAllByRole('treeitem')).toHaveLength(1);
  }, 20000);
  it('generates the mining example and clearly explains that the mine is a facade', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"online":true}')));
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.click(screen.getByText('أمثلة جاهزة للإلهام'));
    fireEvent.click(screen.getByRole('button', { name: /مدينة صحراوية قديمة فيها منجم/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    expect(await screen.findByText(/المنجم مدخل زخرفي يوحي بالعمق فقط/)).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: /Builder/ }));
    fireEvent.click(screen.getByRole('tab', { name: /^Assets$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^House/i }));
    fireEvent.click(screen.getByRole('tab', { name: /^AI$/ }));
    fireEvent.click(screen.getByText('التعلّم والتدريب وحالة المصادر'));
    fireEvent.click(screen.getByRole('button', { name: 'تعلّم من العنصر المحدد' }));
    expect(screen.getByText(/تم التدريب على أبعاد العنصر المحدد/)).toBeTruthy();
    expect(screen.getByText(/الأمثلة الشخصية: 1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'حذف التدريب الشخصي' }));
    expect(screen.getByText(/الأمثلة الشخصية: 0/)).toBeTruthy();
  }, 20000);
});
