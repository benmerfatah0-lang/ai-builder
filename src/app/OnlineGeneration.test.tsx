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
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'ابحث عن بيت في الصحراء' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    expect(await screen.findByText('تم البحث في ويكيبيديا في هذا الطلب.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'مصدر ↗' }).getAttribute('href')).toContain('ar.wikipedia.org/wiki/');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/online', '/api/knowledge', '/api/house-learning', '/api/search']);
  }, 20000);
  it('automatically researches a missing thing beside a known asset in both sources', async () => {
    const image = { title: 'File:Elephant.jpg', url: 'https://commons.wikimedia.org/wiki/File:Elephant.jpg', thumbnail: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Elephant.jpg/240px-Elephant.jpg', author: 'Alice', license_url: 'https://creativecommons.org/licenses/by-sa/4.0/', license_name: 'CC BY-SA 4.0' };
    const fetchMock = vi.fn(async (url: string, options: RequestInit) => {
      if (url === '/api/online') return new Response('{"online":true}');
      if (url === '/api/search' || url === '/api/image-search') {
        expect(JSON.parse(options.body as string).query).toBe('فيل');
        return new Response(JSON.stringify({ results: url === '/api/search' ? [{ title: 'فيل', url: 'https://ar.wikipedia.org/wiki/فيل', content: 'حيوان يعيش في الغابة' }] : [image] }));
      }
      return new Response('{}');
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'بيت وفيل' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    const results = await screen.findByRole('region', { name: 'نتائج البحث التلقائي' });
    expect(within(results).getByText('البحث عن: فيل')).toBeTruthy();
    expect(within(results).getByRole('link', { name: 'فيل ↗' }).getAttribute('href')).toBe('https://ar.wikipedia.org/wiki/فيل');
    expect(within(results).getByRole('img', { name: 'صورة مرجعية: File:Elephant.jpg' })).toBeTruthy();
    expect(await screen.findByText('biome: forest')).toBeTruthy();
    expect(screen.getByText(/سنحاول بناء العناصر المجهولة من الصور/)).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/search')).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/image-search')).toHaveLength(1);
    expect(window.localStorage.getItem('worldforge-wiki-notebook-v1')).toBeNull();
    expect(window.localStorage.getItem('worldforge-image-references-v1')).toBeNull();
  }, 20000);
  it('uses an exact article definition and thumbnail color to build an approximate house', async () => {
    const image = { title: 'File:Hut.jpg', url: 'https://commons.wikimedia.org/wiki/File:Hut.jpg', thumbnail: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Hut.jpg/240px-Hut.jpg', author: 'Alice', license_url: 'https://creativecommons.org/licenses/by/4.0/', license_name: 'CC BY 4.0' };
    const mock = vi.fn(async (url: string) => {
      if (url === '/api/online') return new Response('{"online":true}');
      if (url === '/api/search') return new Response(JSON.stringify({results: [{ title: 'كوخ', url: 'https://ar.wikipedia.org/wiki/كوخ', content: 'الكوخ هو منزل صغير.' }]}));
      if (url === '/api/image-search') return new Response(JSON.stringify({ results: [image] }));
      if (url === '/api/image-analyze') return new Response('{"center_color":"#a04020"}');
      return new Response('{}');
    });
    vi.stubGlobal('fetch', mock);
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'كوخ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    expect(await screen.findByText(/استُخدم كلون البيت/)).toBeTruthy();
    expect(screen.getByText('#a04020')).toBeTruthy();
    expect(screen.getByText(/ممثّل ببيت تقريبي|ممثل ببيت تقريبي/)).toBeTruthy();
    expect(mock.mock.calls.some(([url]) => url === '/api/image-analyze')).toBe(true);
    fireEvent.click(await screen.findByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.click(screen.getByRole('tab', { name: /^Scene$/ }));
    expect(within(screen.getByRole('tree', { name: 'Scene hierarchy' })).getAllByRole('treeitem')).toHaveLength(1);
  }, 20000);
  it('adds an inferred house by text and keeps the addition undoable', async () => {
    const image = { title: 'File:Hut.jpg', url: 'https://commons.wikimedia.org/wiki/File:Hut.jpg', thumbnail: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Hut.jpg/240px-Hut.jpg', author: 'Alice', license_url: 'https://creativecommons.org/licenses/by/4.0/', license_name: 'CC BY 4.0' };
    const mock = vi.fn(async (url: string) => {
      if (url === '/api/online') return new Response('{"online":true}');
      if (url === '/api/search') return new Response(JSON.stringify({ results: [{ title: 'كوخ', url: 'https://ar.wikipedia.org/wiki/كوخ', content: 'كوخ هو منزل صغير.' }] }));
      if (url === '/api/image-search') return new Response(JSON.stringify({ results: [image] }));
      if (url === '/api/image-analyze') return new Response('{"center_color":"#a04020"}');
      return new Response('{}');
    });
    vi.stubGlobal('fetch', mock);
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'شجرة' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    fireEvent.click(await screen.findByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), { target: { value: 'أضف كوخ' } });
    fireEvent.click(screen.getByRole('button', { name: 'تطبيق التعديل' }));
    expect(await screen.findByText(/أُضيف «كوخ» كنموذج بيت تقريبي/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /^Scene$/ }));
    expect(within(screen.getByRole('tree', { name: 'Scene hierarchy' })).getAllByRole('treeitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /Undo \(Ctrl\/Cmd\+Z\)/ }));
    expect(within(screen.getByRole('tree', { name: 'Scene hierarchy' })).getAllByRole('treeitem')).toHaveLength(1);
  }, 20000);
  it('uses a single dictionary sense while generating a world', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/online') return new Response('{"online":true}');
      if (url === '/api/search' || url === '/api/image-search') return new Response('{"results":[]}');
      if (url === '/api/dictionary') return new Response('{"entries":[{"language":"fr","partOfSpeech":"Noun","definition":"house"}],"complete":true}');
      return new Response('{}');
    }));
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'cabane' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    expect(await screen.findByText(/وفق تعريف معجمي محدود/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.click(screen.getByRole('tab', { name: /^Scene$/ }));
    expect(within(screen.getByRole('tree', { name: 'Scene hierarchy' })).getAllByRole('treeitem')).toHaveLength(1);
  }, 20000);
  it('uses a single dictionary sense for a limited, undoable addition', async () => {
    const mock = vi.fn(async (url: string, options: RequestInit) => {
      if (url === '/api/online') return new Response('{"online":true}');
      if (url === '/api/search' || url === '/api/image-search') return new Response('{"results":[]}');
      if (url === '/api/dictionary') {
        expect(JSON.parse(options.body as string).query).toBe('cabane');
        return new Response(JSON.stringify({ entries: [{ language: 'fr', partOfSpeech: 'Noun', definition: 'house' }], complete: true }));
      }
      return new Response('{}');
    });
    vi.stubGlobal('fetch', mock);
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'شجرة' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    fireEvent.click(await screen.findByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), { target: { value: 'ajoute une cabane' } });
    fireEvent.click(screen.getByRole('button', { name: 'تطبيق التعديل' }));
    expect(await screen.findByText(/أُضيف «cabane» كنموذج بيت تقريبي من المعجم/)).toBeTruthy();
    const results = screen.getByRole('region', { name: 'نتائج البحث التلقائي' });
    expect(within(results).getByRole('link', { name: /ويكاموس: cabane/ }).getAttribute('href')).toBe('https://en.wiktionary.org/wiki/cabane');
    expect(within(results).getByText(/فرنسية/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /^Scene$/ }));
    expect(within(screen.getByRole('tree', { name: 'Scene hierarchy' })).getAllByRole('treeitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /Undo \(Ctrl\/Cmd\+Z\)/ }));
    expect(within(screen.getByRole('tree', { name: 'Scene hierarchy' })).getAllByRole('treeitem')).toHaveLength(1);
  }, 20000);
  it('does not overwrite a world changed while an image is being analyzed', async () => {
    const image = { title: 'File:Hut.jpg', url: 'https://commons.wikimedia.org/wiki/File:Hut.jpg', thumbnail: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Hut.jpg/240px-Hut.jpg', author: 'Alice', license_url: 'https://creativecommons.org/licenses/by/4.0/', license_name: 'CC BY 4.0' };
    let finish: ((response: Response) => void) | undefined;
    const delayed = new Promise<Response>((resolve) => { finish = resolve; });
    const mock = vi.fn(async (url: string) => {
      if (url === '/api/online') return new Response('{"online":true}');
      if (url === '/api/search') return new Response(JSON.stringify({ results: [{ title: 'كوخ', url: 'https://ar.wikipedia.org/wiki/كوخ', content: 'الكوخ هو منزل.' }] }));
      if (url === '/api/image-search') return new Response(JSON.stringify({ results: [image] }));
      if (url === '/api/image-analyze') return delayed;
      return new Response('{}');
    });
    vi.stubGlobal('fetch', mock);
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'كوخ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    await waitFor(() => expect(mock.mock.calls.some(([url]) => url === '/api/image-analyze')).toBe(true));
    fireEvent.change(screen.getByLabelText('World name'), { target: { value: 'Preserve my edit' } });
    fireEvent.blur(screen.getByLabelText('World name'));
    finish!(new Response('{"center_color":"#a04020"}'));
    expect((await screen.findByRole('alert')).textContent).toContain('تغيّر العالم أثناء البحث');
    expect((screen.getByLabelText('World name') as HTMLInputElement).value).toBe('Preserve my edit');
    expect(screen.queryByText('World generated')).toBeNull();
  }, 20000);
  it('does not apply a delayed approximation after the edit command changes', async () => {
    const image = { title: 'File:Hut.jpg', url: 'https://commons.wikimedia.org/wiki/File:Hut.jpg', thumbnail: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Hut.jpg/240px-Hut.jpg', author: 'Alice', license_url: 'https://creativecommons.org/licenses/by/4.0/', license_name: 'CC BY 4.0' };
    let finish: ((response: Response) => void) | undefined;
    const delayed = new Promise<Response>((resolve) => { finish = resolve; });
    const mock = vi.fn(async (url: string) => {
      if (url === '/api/online') return new Response('{"online":true}');
      if (url === '/api/search') return new Response(JSON.stringify({ results: [{ title: 'كوخ', url: 'https://ar.wikipedia.org/wiki/كوخ', content: 'كوخ هو منزل صغير.' }] }));
      if (url === '/api/image-search') return new Response(JSON.stringify({ results: [image] }));
      if (url === '/api/image-analyze') return delayed;
      return new Response('{}');
    });
    vi.stubGlobal('fetch', mock);
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'شجرة' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    fireEvent.click(await screen.findByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), { target: { value: 'أضف كوخ' } });
    fireEvent.click(screen.getByRole('button', { name: 'تطبيق التعديل' }));
    await waitFor(() => expect(mock.mock.calls.some(([url]) => url === '/api/image-analyze')).toBe(true));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), { target: { value: 'أضف صخرة' } });
    finish!(new Response('{"center_color":"#a04020"}'));
    expect(await screen.findByText(/تغيّر العالم أو الأمر أثناء البحث/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /^Scene$/ }));
    expect(within(screen.getByRole('tree', { name: 'Scene hierarchy' })).getAllByRole('treeitem')).toHaveLength(1);
  }, 20000);
  it('shows failures from both lookup services instead of claiming success', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/online') return new Response('{"online":true}');
      if (url === '/api/search' || url === '/api/image-search') return new Response('', { status: 502 });
      return new Response('{}');
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'قلعة' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    expect(await screen.findByText(/تعذّر البحث عن الصور في Wikimedia Commons/)).toBeTruthy();
    expect(screen.getByText(/تعذّر البحث في ويكيبيديا؛ لم تُستخدم نتائج منها/)).toBeTruthy();
    expect(await screen.findByText('World generated')).toBeTruthy();
  }, 20000);
  it('searches after an unsupported text edit without changing the world', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/online') return new Response('{"online":true}');
      if (url === '/api/search' || url === '/api/image-search') return new Response('{"results":[]}');
      return new Response('{}');
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'بيت' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    fireEvent.click(await screen.findByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), { target: { value: 'أضف فيل' } });
    fireEvent.click(screen.getByRole('button', { name: 'تطبيق التعديل' }));
    expect(await screen.findByText('البحث عن: فيل')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('لم أجد صوراً مناسبة');
    fireEvent.click(screen.getByRole('tab', { name: /^Scene$/ }));
    expect(within(screen.getByRole('tree', { name: 'Scene hierarchy' })).getAllByRole('treeitem')).toHaveLength(1);
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
      const mobileAI = within(screen.getByRole('dialog', { name: 'AI world' }));
      expect(mobileAI.getByLabelText('تعديل العالم بالكتابة')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /Forge/ }));
      expect(screen.getByLabelText('Description')).toBeTruthy();
    } finally { browser.happyDOM.setViewport({ width: 1024, height: 768 }); }
  }, 20000);
  it('adds a misspelled river through an existing village and undoes the actual map change', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/api/online') return new Response('{"online":true}');
      return new Response('{}');
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Seed'), { target: { value: '7' } });
    fireEvent.blur(screen.getByLabelText('Seed'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'قرية' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    fireEvent.click(await screen.findByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.click(screen.getByRole('tab', { name: /^Scene$/ }));
    const tree = screen.getByRole('tree', { name: 'Scene hierarchy' });
    const before = within(tree).getAllByRole('treeitem').length;
    fireEvent.click(screen.getByRole('tab', { name: /^AI$/ }));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), { target: { value: 'اصنع لي نهرر يمر وسط القريية' } });
    fireEvent.click(screen.getByRole('button', { name: 'تطبيق التعديل' }));
    expect(await screen.findByText(/تصحيح إملائي محدود/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /^Scene$/ }));
    const updatedTree = screen.getByRole('tree', { name: 'Scene hierarchy' });
    expect(within(updatedTree).getAllByRole('treeitem')).toHaveLength(before + 1);
    expect(within(updatedTree).getByText('Village river')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Undo \(Ctrl\/Cmd\+Z\)/ }));
    expect(within(updatedTree).getAllByRole('treeitem')).toHaveLength(before);
    expect(within(updatedTree).queryByText('Village river')).toBeNull();
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
  it('asks between ambiguous images, constructs an actual photo model, and undoes it', async () => {
    const image = (name: string) => ({ title: `File:${name}.png`, url: `https://commons.wikimedia.org/wiki/File:${name}.png`, thumbnail: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${name}.png/240px-${name}.png`, author: 'Alice', license_url: 'https://creativecommons.org/licenses/by/4.0/', license_name: 'CC BY 4.0' });
    const bytes = new Uint8Array(12 * 12 * 4);
    for (let y=0; y<12; y++) for (let x=0; x<12; x++) bytes.set(x>=3 && x<=8 && y>=2 && y<=9 ? [120,40,30,255] : [255,255,255,255], (y*12+x)*4);
    const mock = vi.fn(async (url: string) => {
      if (url === '/api/online') return new Response('{"online":true}');
      if (url === '/api/search') return new Response('{"results":[]}');
      if (url === '/api/image-search') return new Response(JSON.stringify({ results: [image('Elephant'), image('Animal')] }));
      if (url === '/api/image-pixels') return new Response(JSON.stringify({ width: 12, height: 12, rgba: btoa(String.fromCharCode(...bytes)) }));
      return new Response('{}');
    });
    vi.stubGlobal('fetch', mock);
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'شجرة' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    fireEvent.click(await screen.findByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), { target: { value: 'أضف فيل' } });
    fireEvent.click(screen.getByRole('button', { name: 'تطبيق التعديل' }));
    const studio = await screen.findByRole('region', { name: 'استوديو تقريب الصورة' });
    expect(mock.mock.calls.filter(([url]) => url === '/api/image-pixels')).toHaveLength(0);
    fireEvent.click(within(studio).getByRole('button', { name: /File:Elephant.png/ }));
    await screen.findByText(/بناء طبقات الشكل/);
    expect(within(screen.getByLabelText('3D viewport')).getByText(/بناء «فيل».*معاينة مؤقتة/)).toBeTruthy();
    expect(mock.mock.calls.filter(([url]) => url === '/api/image-pixels')).toHaveLength(1);
    // Switching panels must not cancel the running edit or put the draft in history.
    fireEvent.click(screen.getByRole('tab', { name: /^Scene$/ }));
    const tree = screen.getByRole('tree', { name: 'Scene hierarchy' });
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(1);
    await waitFor(() => expect(within(tree).getAllByRole('treeitem')).toHaveLength(2), { timeout: 5000 });
    fireEvent.click(screen.getByRole('button', { name: /Undo \(Ctrl\/Cmd\+Z\)/ }));
    expect(within(screen.getByRole('tree', { name: 'Scene hierarchy' })).getAllByRole('treeitem')).toHaveLength(1);
  }, 20000);
  it('does not add a photo model after the edit command changes during construction', async () => {
    const image = { title: 'File:Elephant.png', url: 'https://commons.wikimedia.org/wiki/File:Elephant.png', thumbnail: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Elephant.png/240px-Elephant.png', author: 'Alice', license_url: 'https://creativecommons.org/licenses/by/4.0/', license_name: 'CC BY 4.0' };
    const bytes = new Uint8Array(12*12*4);
    for (let y=0;y<12;y++) for (let x=0;x<12;x++) bytes.set(x>=3 && x<=8 && y>=2 && y<=9 ? [120,40,30,255] : [255,255,255,255], (y*12+x)*4);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/online') return new Response('{"online":true}');
      if (url === '/api/search') return new Response('{"results":[]}');
      if (url === '/api/image-search') return new Response(JSON.stringify({results:[image]}));
      if (url === '/api/image-pixels') return new Response(JSON.stringify({width:12,height:12,rgba:btoa(String.fromCharCode(...bytes))}));
      return new Response('{}');
    }));
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'شجرة' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    fireEvent.click(await screen.findByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), { target: { value: 'أضف فيل' } });
    fireEvent.click(screen.getByRole('button', { name: 'تطبيق التعديل' }));
    await screen.findByText(/بناء طبقات الشكل/);
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), { target: { value: 'أضف صخرة' } });
    expect(await screen.findByText(/تغيّر العالم أو التحديد أو الأمر أثناء البناء/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /^Scene$/ }));
    expect(within(screen.getByRole('tree', { name: 'Scene hierarchy' })).getAllByRole('treeitem')).toHaveLength(1);
  }, 20000);

  it('automatically builds a single-image model during simple world creation', async () => {
    const image = { title: 'File:Elephant.png', url: 'https://commons.wikimedia.org/wiki/File:Elephant.png', thumbnail: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Elephant.png/240px-Elephant.png', author: 'Alice', license_url: 'https://creativecommons.org/licenses/by/4.0/', license_name: 'CC BY 4.0' };
    const bytes = new Uint8Array(12*12*4);
    for (let y=0;y<12;y++) for (let x=0;x<12;x++) bytes.set(x>=3&&x<=8&&y>=2&&y<=9 ? [120,40,30,255] : [255,255,255,255], (y*12+x)*4);
    const mock = vi.fn(async (url: string) => {
      if (url === '/api/online') return new Response('{"online":true}');
      if (url === '/api/search') return new Response('{"results":[]}');
      if (url === '/api/image-search') return new Response(JSON.stringify({results:[image]}));
      if (url === '/api/image-pixels') return new Response(JSON.stringify({width:12,height:12,rgba:btoa(String.fromCharCode(...bytes))}));
      return new Response('{}');
    });
    vi.stubGlobal('fetch', mock);
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'عالم فيه فيل' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    expect(await screen.findByText(/أُضيف مجسم الصورة التقريبي؛/)).toBeTruthy();
    expect(mock.mock.calls.filter(([url]) => url === '/api/image-pixels')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.click(screen.getByRole('tab', { name: /^Scene$/ }));
    expect(within(screen.getByRole('tree', { name: 'Scene hierarchy' })).getByText('فيل')).toBeTruthy();
  }, 20000);

  it('cancels an ongoing multi-source search without replacing the world', async () => {
    const mock = vi.fn((url: string, options: RequestInit) => {
      if (url === '/api/online') return Promise.resolve(new Response('{"online":true}'));
      if (url === '/api/search') return new Promise<Response>((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once:true }));
      if (url === '/api/image-search') return Promise.resolve(new Response('{"results":[]}'));
      if (url === '/api/dictionary') return Promise.resolve(new Response('{"entries":[],"complete":true}'));
      return Promise.resolve(new Response('{}'));
    });
    vi.stubGlobal('fetch', mock);
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'عالم فيه فيل' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    fireEvent.click(await screen.findByRole('button', { name: 'إيقاف البحث' }));
    expect((await screen.findByRole('alert')).textContent).toContain('أُوقف البحث؛ لم يُنشأ العالم');
    expect(screen.queryByText('World generated')).toBeNull();
  }, 20000);

  it('generates multiple researched shapes and explicit copies into one map', async () => {
    const image = (name: string) => ({ title: `File:${name}.png`, url: `https://commons.wikimedia.org/wiki/File:${name}.png`, thumbnail: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${name}.png/240px-${name}.png`, author: 'Alice', license_url: 'https://creativecommons.org/licenses/by/4.0/', license_name: 'CC BY 4.0' });
    const bytes = new Uint8Array(12*12*4);
    for (let y=0;y<12;y++) for (let x=0;x<12;x++) bytes.set(x>=3&&x<=8&&y>=2&&y<=9 ? [120,40,30,255] : [255,255,255,255], (y*12+x)*4);
    const mock=vi.fn(async (url: string, options: RequestInit) => {
      if(url === '/api/online') return new Response('{"online":true}');
      if(url === '/api/search') return new Response('{"results":[]}');
      if(url === '/api/image-search') return new Response(JSON.stringify({results:[image(JSON.parse(options.body as string).query === 'فيل' ? 'Elephant' : 'Giraffe')]}));
      if(url === '/api/image-pixels') return new Response(JSON.stringify({width:12,height:12,rgba:btoa(String.fromCharCode(...bytes))}));
      if(url === '/api/dictionary') return new Response('{"entries":[],"complete":true}');
      return new Response('{}');
    });
    vi.stubGlobal('fetch', mock);
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'بيت و2 فيل وزرافة' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    expect(await screen.findByText(/أُضيف 2 من «فيل»/)).toBeTruthy();
    expect(await screen.findByText(/أُضيف مجسم الصورة التقريبي؛ «زرافة»/)).toBeTruthy();
    expect(mock.mock.calls.filter(([url]) => url === '/api/image-pixels')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.click(screen.getByRole('tab', { name: /^Scene$/ }));
    const tree=screen.getByRole('tree', {name:'Scene hierarchy'});
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(4);
    expect(within(tree).getByText('فيل 1')).toBeTruthy();
    expect(within(tree).getByText('فيل 2')).toBeTruthy();
    expect(within(tree).getByText('زرافة')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Undo \(Ctrl\/Cmd\+Z\)/ }));
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: /Undo \(Ctrl\/Cmd\+Z\)/ }));
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(1);
  }, 20000);
  it('adds multiple photo models in one atomic edit and undoes the entire edit', async () => {
    const image = (name: string) => ({ title: `File:${name}.png`, url: `https://commons.wikimedia.org/wiki/File:${name}.png`, thumbnail: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${name}.png/240px-${name}.png`, author: 'Alice', license_url: 'https://creativecommons.org/licenses/by/4.0/', license_name: 'CC BY 4.0' });
    const bytes=new Uint8Array(12*12*4);
    for(let y=0;y<12;y++) for(let x=0;x<12;x++) bytes.set(x>=3&&x<=8&&y>=2&&y<=9 ? [120,40,30,255] : [255,255,255,255],(y*12+x)*4);
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      if(url === '/api/online') return new Response('{"online":true}');
      if(url === '/api/search') return new Response('{"results":[]}');
      if(url === '/api/image-search') return new Response(JSON.stringify({results:[image(JSON.parse(options.body as string).query === 'فيل' ? 'Elephant' : 'Giraffe')]}));
      if(url === '/api/image-pixels') return new Response(JSON.stringify({width:12,height:12,rgba:btoa(String.fromCharCode(...bytes))}));
      if(url === '/api/dictionary') return new Response('{"entries":[],"complete":true}');
      return new Response('{}');
    }));
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'شجرة' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    fireEvent.click(await screen.findByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), { target: { value: 'أضف 2 فيل وزرافة' } });
    fireEvent.click(screen.getByRole('button', { name: 'تطبيق التعديل' }));
    expect(await screen.findByText(/أُضيفت مجسمات الصور التقريبية معاً/, {}, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /^Scene$/ }));
    const tree = screen.getByRole('tree', {name:'Scene hierarchy'});
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: /Undo \(Ctrl\/Cmd\+Z\)/ }));
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(1);
  }, 20000);

  it('does not commit any part of a multi-photo edit if the second image fails and the user cancels', async () => {
    const image = (name: string) => ({ title: `File:${name}.png`, url: `https://commons.wikimedia.org/wiki/File:${name}.png`, thumbnail: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${name}.png/240px-${name}.png`, author: 'Alice', license_url: 'https://creativecommons.org/licenses/by/4.0/', license_name: 'CC BY 4.0' });
    const bytes=new Uint8Array(12*12*4);
    for(let y=0;y<12;y++) for(let x=0;x<12;x++) bytes.set(x>=3&&x<=8&&y>=2&&y<=9 ? [120,40,30,255] : [255,255,255,255],(y*12+x)*4);
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      if(url === '/api/online') return new Response('{"online":true}');
      if(url === '/api/search') return new Response('{"results":[]}');
      if(url === '/api/image-search') return new Response(JSON.stringify({results:[image(JSON.parse(options.body as string).query === 'فيل' ? 'Elephant' : 'Giraffe')]}));
      if(url === '/api/image-pixels') return new Response(JSON.stringify(JSON.parse(options.body as string).url.includes('Giraffe') ? {} : {width:12,height:12,rgba:btoa(String.fromCharCode(...bytes))}));
      if(url === '/api/dictionary') return new Response('{"entries":[],"complete":true}');
      return new Response('{}');
    }));
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'شجرة' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    fireEvent.click(await screen.findByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), { target: { value: 'أضف فيل وزرافة' } });
    fireEvent.click(screen.getByRole('button', { name: 'تطبيق التعديل' }));
    expect(await screen.findByText(/بيانات الصورة غير صالحة.*لم يُضف مجسم/, {}, { timeout:5000 })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء التعديل' }));
    expect(screen.getByText(/أُلغي التعديل؛ لم يتغير العالم/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /^Scene$/ }));
    expect(within(screen.getByRole('tree', {name:'Scene hierarchy'})).getAllByRole('treeitem')).toHaveLength(1);
  }, 20000);

  it('adds one researched object relative to a uniquely known reference in an edit', async () => {
    const image = { title:'File:Elephant.png', url:'https://commons.wikimedia.org/wiki/File:Elephant.png', thumbnail:'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Elephant.png/240px-Elephant.png', author:'Alice', license_url:'https://creativecommons.org/licenses/by/4.0/', license_name:'CC BY 4.0' };
    const bytes = new Uint8Array(12*12*4);
    for(let y=0;y<12;y++) for(let x=0;x<12;x++) bytes.set(x>=3&&x<=8&&y>=2&&y<=9 ? [120,40,30,255] : [255,255,255,255],(y*12+x)*4);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if(url === '/api/online') return new Response('{"online":true}');
      if(url === '/api/search') return new Response('{"results":[]}');
      if(url === '/api/image-search') return new Response(JSON.stringify({results:[image]}));
      if(url === '/api/image-pixels') return new Response(JSON.stringify({width:12,height:12,rgba:btoa(String.fromCharCode(...bytes))}));
      if(url === '/api/dictionary') return new Response('{"entries":[],"complete":true}');
      return new Response('{}');
    }));
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'بيت' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate world' }));
    fireEvent.click(await screen.findByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), { target: { value: 'أضف فيل يمين البيت' } });
    fireEvent.click(screen.getByRole('button', { name: 'تطبيق التعديل' }));
    expect(await screen.findByText(/أُضيف مجسم الصورة التقريبي في مكان متاح/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /^Scene$/ }));
    expect(within(screen.getByRole('tree', {name:'Scene hierarchy'})).getAllByRole('treeitem')).toHaveLength(2);
  }, 20000);

  it('continues a selected Forge image in the real map after navigating to Builder', async () => {
    const image = (name: string) => ({ title: `File:${name}.png`, url: `https://commons.wikimedia.org/wiki/File:${name}.png`, thumbnail: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${name}.png/240px-${name}.png`, author: 'Alice', license_url: 'https://creativecommons.org/licenses/by/4.0/', license_name: 'CC BY 4.0' });
    const bytes = new Uint8Array(12*12*4);
    for (let y=0;y<12;y++) for (let x=0;x<12;x++) bytes.set(x>=3&&x<=8&&y>=2&&y<=9 ? [120,40,30,255] : [255,255,255,255], (y*12+x)*4);
    const mock = vi.fn(async (url: string) => {
      if (url === '/api/online') return new Response('{"online":true}');
      if (url === '/api/search') return new Response('{"results":[]}');
      if (url === '/api/image-search') return new Response(JSON.stringify({ results:[image('Elephant'), image('Animal')] }));
      if (url === '/api/image-pixels') return new Response(JSON.stringify({width:12,height:12,rgba:btoa(String.fromCharCode(...bytes))}));
      return new Response('{}');
    });
    vi.stubGlobal('fetch', mock); render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value:'عالم فيه فيل' } });
    fireEvent.click(screen.getByRole('button', { name:'Generate world' }));
    const studio = await screen.findByRole('region', { name:'استوديو تقريب الصورة' });
    expect(mock.mock.calls.filter(([url]) => url === '/api/image-pixels')).toHaveLength(0);
    fireEvent.click(within(studio).getByRole('button', { name:/File:Elephant.png/ }));
    await screen.findByText(/بناء طبقات الشكل/);
    expect(screen.getByLabelText('معاينة البناء داخل الماب')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name:/Builder/ }));
    expect(within(screen.getByLabelText('3D viewport')).getByText(/بناء «فيل».*معاينة مؤقتة/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name:/^Scene$/ }));
    const tree = screen.getByRole('tree', { name:'Scene hierarchy' });
    expect(within(tree).queryByText('فيل')).toBeNull();
    await waitFor(() => expect(within(tree).getByText('فيل')).toBeTruthy(), {timeout:5000});
    fireEvent.click(screen.getByRole('button', { name:/Undo \(Ctrl\/Cmd\+Z\)/ }));
    expect(within(tree).queryByText('فيل')).toBeNull();
  }, 20000);

  it('reports complex images and only creates a whole-image slab after explicit consent', async () => {
    const image = { title:'File:Elephant.png', url:'https://commons.wikimedia.org/wiki/File:Elephant.png', thumbnail:'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Elephant.png/240px-Elephant.png', author:'Alice', license_url:'https://creativecommons.org/licenses/by/4.0/', license_name:'CC BY 4.0' };
    const bytes = new Uint8Array(12*12*4);
    for (let y=0;y<12;y++) for (let x=0;x<12;x++) { const bg=(x+y)%2 ? 0 : 255; bytes.set([bg,bg,bg,255], (y*12+x)*4); }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/online') return new Response('{"online":true}');
      if (url === '/api/search') return new Response('{"results":[]}');
      if (url === '/api/image-search') return new Response(JSON.stringify({results:[image]}));
      if (url === '/api/image-pixels') return new Response(JSON.stringify({width:12,height:12,rgba:btoa(String.fromCharCode(...bytes))}));
      return new Response('{}');
    }));
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('Description'), {target:{value:'عالم فيه فيل'}});
    fireEvent.click(screen.getByRole('button', {name:'Generate world'}));
    expect((await screen.findByRole('alert')).textContent).toContain('لم يُضف مجسم');
    expect(screen.getByText(/بما فيها الخلفية/)).toBeTruthy();
    expect(screen.queryByText(/أُضيف مجسم الصورة/)).toBeNull();
    fireEvent.click(screen.getByRole('button', {name:'استخدم الصورة كاملة كلوح تقريبي'}));
    expect(await screen.findByText(/أُضيف 1 من «فيل»: لوح الصورة كاملة بما فيها الخلفية/, {}, {timeout:5000})).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name:'فتح العالم في المحرر ←'}));
    fireEvent.click(screen.getByRole('tab', {name:/^Scene$/}));
    expect(within(screen.getByRole('tree', {name:'Scene hierarchy'})).getByText('فيل')).toBeTruthy();
  }, 20000);

  it('keeps the mobile edit running when its AI sheet is closed', async () => {
    const browser = window as unknown as { happyDOM: { setViewport: (viewport: {width:number; height:number}) => void } };
    browser.happyDOM.setViewport({width:390, height:844});
    try {
      const image = {title:'File:Elephant.png', url:'https://commons.wikimedia.org/wiki/File:Elephant.png', thumbnail:'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Elephant.png/240px-Elephant.png', author:'Alice', license_url:'https://creativecommons.org/licenses/by/4.0/', license_name:'CC BY 4.0'};
      const bytes = new Uint8Array(12*12*4);
      for (let y=0;y<12;y++) for (let x=0;x<12;x++) bytes.set(x>=3&&x<=8&&y>=2&&y<=9 ? [120,40,30,255] : [255,255,255,255], (y*12+x)*4);
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url === '/api/online') return new Response('{"online":true}');
        if (url === '/api/search') return new Response('{"results":[]}');
        if (url === '/api/image-search') return new Response(JSON.stringify({results:[image]}));
        if (url === '/api/image-pixels') return new Response(JSON.stringify({width:12,height:12,rgba:btoa(String.fromCharCode(...bytes))}));
        return new Response('{}');
      }));
      render(<App />);
      await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
      fireEvent.click(screen.getByRole('button', {name:/Builder/}));
      const sheet = screen.getByRole('dialog', {name:'AI world'});
      fireEvent.change(within(sheet).getByLabelText('تعديل العالم بالكتابة'), {target:{value:'أضف فيل'}});
      fireEvent.click(within(sheet).getByRole('button', {name:'تطبيق التعديل'}));
      await screen.findByText(/بناء طبقات الشكل/);
      fireEvent.click(within(sheet).getByRole('button', {name:'Close panel'}));
      expect(within(screen.getByLabelText('3D viewport')).getByText(/بناء «فيل».*معاينة مؤقتة/)).toBeTruthy();
      fireEvent.click(within(screen.getByRole('navigation', {name:'Editor panels'})).getByRole('button', {name:'Scene'}));
      const tree = within(screen.getByRole('dialog', {name:'Scene'})).getByRole('tree', {name:'Scene hierarchy'});
      expect(within(tree).queryByText('فيل')).toBeNull();
      await waitFor(() => expect(within(tree).getByText('فيل')).toBeTruthy(), {timeout:5000});
    } finally { browser.happyDOM.setViewport({width:1024,height:768}); }
  }, 20000);

  it('removes a running preview on cancellation without adding a draft to the map', async () => {
    const image = {title:'File:Elephant.png', url:'https://commons.wikimedia.org/wiki/File:Elephant.png', thumbnail:'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Elephant.png/240px-Elephant.png', author:'Alice', license_url:'https://creativecommons.org/licenses/by/4.0/', license_name:'CC BY 4.0'};
    const bytes = new Uint8Array(12*12*4);
    for (let y=0;y<12;y++) for (let x=0;x<12;x++) bytes.set(x>=3&&x<=8&&y>=2&&y<=9 ? [120,40,30,255] : [255,255,255,255], (y*12+x)*4);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/online') return new Response('{"online":true}');
      if (url === '/api/search') return new Response('{"results":[]}');
      if (url === '/api/image-search') return new Response(JSON.stringify({results:[image]}));
      if (url === '/api/image-pixels') return new Response(JSON.stringify({width:12,height:12,rgba:btoa(String.fromCharCode(...bytes))}));
      return new Response('{}');
    }));
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.click(screen.getByRole('button', {name:/Builder/}));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), {target:{value:'أضف فيل'}});
    fireEvent.click(screen.getByRole('button', {name:'تطبيق التعديل'}));
    await screen.findByText(/بناء طبقات الشكل/);
    expect(within(screen.getByLabelText('3D viewport')).getByText(/بناء «فيل».*معاينة مؤقتة/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name:'إلغاء التعديل'}));
    expect(screen.getByText(/أُلغي التعديل؛ لم يتغير العالم/)).toBeTruthy();
    expect(within(screen.getByLabelText('3D viewport')).queryByText(/بناء «فيل».*معاينة مؤقتة/)).toBeNull();
    fireEvent.click(screen.getByRole('tab', {name:/^Scene$/}));
    expect(within(screen.getByRole('tree', {name:'Scene hierarchy'})).queryByText('فيل')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(within(screen.getByRole('tree', {name:'Scene hierarchy'})).queryByText('فيل')).toBeNull();
  }, 20000);

});
