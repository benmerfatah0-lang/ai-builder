// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.localStorage.clear(); });
describe('lightweight local planning interface', () => {
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
    fireEvent.change(screen.getByLabelText('وصف العالم'), { target: { value: 'شجرة' } });
    if (!(screen.getByLabelText('استخدام البناء المحلي فقط') as HTMLInputElement).checked) fireEvent.click(screen.getByLabelText('استخدام البناء المحلي فقط')); fireEvent.click(screen.getByRole('button', { name: 'إنشاء العالم' }));
    fireEvent.click(await screen.findByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), { target: { value: 'أضف كوخ' } });
    fireEvent.click(screen.getByRole('button', { name: 'تطبيق التعديل' }));
    expect(await screen.findByText(/أُضيف «كوخ» كنموذج بيت تقريبي/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /^العناصر$/ }));
    expect(within(screen.getByRole('tree', { name: 'Scene hierarchy' })).getAllByRole('treeitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /Undo \(Ctrl\/Cmd\+Z\)/ }));
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
    fireEvent.change(screen.getByLabelText('وصف العالم'), { target: { value: 'شجرة' } });
    if (!(screen.getByLabelText('استخدام البناء المحلي فقط') as HTMLInputElement).checked) fireEvent.click(screen.getByLabelText('استخدام البناء المحلي فقط')); fireEvent.click(screen.getByRole('button', { name: 'إنشاء العالم' }));
    fireEvent.click(await screen.findByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), { target: { value: 'ajoute une cabane' } });
    fireEvent.click(screen.getByRole('button', { name: 'تطبيق التعديل' }));
    expect(await screen.findByText(/أُضيف «cabane» كنموذج بيت تقريبي من المعجم/)).toBeTruthy();
    const results = screen.getByRole('region', { name: 'نتائج البحث التلقائي' });
    expect(within(results).getByRole('link', { name: /ويكاموس: cabane/ }).getAttribute('href')).toBe('https://en.wiktionary.org/wiki/cabane');
    expect(within(results).getByText(/فرنسية/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /^العناصر$/ }));
    expect(within(screen.getByRole('tree', { name: 'Scene hierarchy' })).getAllByRole('treeitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /Undo \(Ctrl\/Cmd\+Z\)/ }));
    expect(within(screen.getByRole('tree', { name: 'Scene hierarchy' })).getAllByRole('treeitem')).toHaveLength(1);
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
    fireEvent.change(screen.getByLabelText('وصف العالم'), { target: { value: 'شجرة' } });
    if (!(screen.getByLabelText('استخدام البناء المحلي فقط') as HTMLInputElement).checked) fireEvent.click(screen.getByLabelText('استخدام البناء المحلي فقط')); fireEvent.click(screen.getByRole('button', { name: 'إنشاء العالم' }));
    fireEvent.click(await screen.findByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), { target: { value: 'أضف كوخ' } });
    fireEvent.click(screen.getByRole('button', { name: 'تطبيق التعديل' }));
    await waitFor(() => expect(mock.mock.calls.some(([url]) => url === '/api/image-analyze')).toBe(true));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), { target: { value: 'أضف صخرة' } });
    finish!(new Response('{"center_color":"#a04020"}'));
    expect(await screen.findByText(/تغيّر العالم أو الأمر أثناء البحث/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /^العناصر$/ }));
    expect(within(screen.getByRole('tree', { name: 'Scene hierarchy' })).getAllByRole('treeitem')).toHaveLength(1);
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
    fireEvent.change(screen.getByLabelText('وصف العالم'), { target: { value: 'بيت' } });
    if (!(screen.getByLabelText('استخدام البناء المحلي فقط') as HTMLInputElement).checked) fireEvent.click(screen.getByLabelText('استخدام البناء المحلي فقط')); fireEvent.click(screen.getByRole('button', { name: 'إنشاء العالم' }));
    fireEvent.click(await screen.findByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), { target: { value: 'أضف فيل' } });
    fireEvent.click(screen.getByRole('button', { name: 'تطبيق التعديل' }));
    expect(await screen.findByText('البحث عن: فيل')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('لم أجد صوراً مناسبة');
    fireEvent.click(screen.getByRole('tab', { name: /^العناصر$/ }));
    expect(within(screen.getByRole('tree', { name: 'Scene hierarchy' })).getAllByRole('treeitem')).toHaveLength(1);
  }, 20000);
  it('creates a named world from the Forge home and opens the existing 3D editor', async () => {
    const responses = [new Response('{"online":true}'), new Response(JSON.stringify({ version: 1, cursor: 0, status: 'starting', classes: { desert: {docs:0,tokens:{}}, forest: {docs:0,tokens:{}}, mountains: {docs:0,tokens:{}}, island: {docs:0,tokens:{}} }, sources: [] })), new Response(JSON.stringify({ version: 1, cursor: 0, status: 'starting', samples: 0, last_loss: null, sources: [], profiles: Object.fromEntries(['default', 'small', 'tall', 'wide'].map(key => [key, {count: 0, mean: [1, 1, 1, 1]}])) }))];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(responses[0]).mockResolvedValueOnce(responses[1]).mockResolvedValueOnce(responses[2]));
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    expect(screen.getByRole('heading', { name: 'اصنع عالمك من الخيال' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('وصف العالم'), { target: { value: 'بيت وشجرة' } });
    fireEvent.change(screen.getByLabelText('اسم العالم (اختياري)'), { target: { value: 'عالمي الجديد' } });
    if (!(screen.getByLabelText('استخدام البناء المحلي فقط') as HTMLInputElement).checked) fireEvent.click(screen.getByLabelText('استخدام البناء المحلي فقط')); fireEvent.click(screen.getByRole('button', { name: 'إنشاء العالم' }));
    fireEvent.click(await screen.findByRole('button', { name: 'فتح العالم في المحرر ←' }));
    expect((screen.getByLabelText('World name') as HTMLInputElement).value).toBe('عالمي الجديد');
    expect(screen.getByRole('region', { name: '3D viewport' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'المكتبة' }));
    expect(await screen.findByRole('dialog', { name: 'World library' })).toBeTruthy();
  }, 20000);
  it('opens the library and editor from the Forge navigation at phone width', async () => {
    const browser = window as unknown as { happyDOM: { setViewport: (viewport: { width: number; height: number }) => void } };
    browser.happyDOM.setViewport({ width: 390, height: 844 });
    try {
      render(<App />);
      await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
      expect(screen.getByRole('heading', { name: 'اصنع عالمك من الخيال' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'المكتبة' }));
      expect(await screen.findByRole('dialog', { name: 'World library' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Close library' }));
      fireEvent.click(screen.getByRole('button', { name: 'المحرر' }));
      expect(await screen.findByRole('navigation', { name: 'Editor panels' })).toBeTruthy();
      const mobileAI = within(screen.getByRole('dialog', { name: 'بناء وتعديل' }));
      expect(mobileAI.getByLabelText('تعديل العالم بالكتابة')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'إنشاء' }));
      expect(screen.getByLabelText('وصف العالم')).toBeTruthy();
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
    fireEvent.change(screen.getByLabelText('وصف العالم'), { target: { value: 'قرية' } });
    if (!(screen.getByLabelText('استخدام البناء المحلي فقط') as HTMLInputElement).checked) fireEvent.click(screen.getByLabelText('استخدام البناء المحلي فقط')); fireEvent.click(screen.getByRole('button', { name: 'إنشاء العالم' }));
    fireEvent.click(await screen.findByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.click(screen.getByRole('tab', { name: /^العناصر$/ }));
    const tree = screen.getByRole('tree', { name: 'Scene hierarchy' });
    const before = within(tree).getAllByRole('treeitem').length;
    fireEvent.click(screen.getByRole('tab', { name: /^بناء وتعديل$/ }));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), { target: { value: 'اصنع لي نهرر يمر وسط القريية' } });
    fireEvent.click(screen.getByRole('button', { name: 'تطبيق التعديل' }));
    expect(await screen.findByText(/تصحيح إملائي محدود/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /^العناصر$/ }));
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
    fireEvent.change(screen.getByLabelText('وصف العالم'), { target: { value: 'بيت' } });
    if (!(screen.getByLabelText('استخدام البناء المحلي فقط') as HTMLInputElement).checked) fireEvent.click(screen.getByLabelText('استخدام البناء المحلي فقط')); fireEvent.click(screen.getByRole('button', { name: 'إنشاء العالم' }));
    fireEvent.click(await screen.findByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), { target: { value: 'أضف شجرتين على يمين البيت' } });
    fireEvent.click(screen.getByRole('button', { name: 'تطبيق التعديل' }));
    expect(await screen.findByText(/أُضيف 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /^العناصر$/ }));
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
    if (!(screen.getByLabelText('استخدام البناء المحلي فقط') as HTMLInputElement).checked) fireEvent.click(screen.getByLabelText('استخدام البناء المحلي فقط')); fireEvent.click(screen.getByRole('button', { name: 'إنشاء العالم' }));
    expect(await screen.findByText(/المنجم مدخل زخرفي/)).toBeTruthy();
  }, 20000);
  it('learns an explicitly selected house and can delete personal training', async () => {
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.click(screen.getByRole('button', { name: 'المحرر' }));
    fireEvent.click(screen.getByRole('tab', { name: /^أشكال$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^House/i }));
    fireEvent.click(screen.getByRole('tab', { name: /^بناء وتعديل$/ }));
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
    fireEvent.change(screen.getByLabelText('وصف العالم'), { target: { value: 'شجرة' } });
    if (!(screen.getByLabelText('استخدام البناء المحلي فقط') as HTMLInputElement).checked) fireEvent.click(screen.getByLabelText('استخدام البناء المحلي فقط')); fireEvent.click(screen.getByRole('button', { name: 'إنشاء العالم' }));
    fireEvent.click(await screen.findByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), { target: { value: 'أضف فيل' } });
    fireEvent.click(screen.getByRole('button', { name: 'تطبيق التعديل' }));
    const studio = await screen.findByRole('region', { name: 'استوديو تقريب الصورة' });
    expect(mock.mock.calls.filter(([url]) => url === '/api/image-pixels')).toHaveLength(0);
    fireEvent.click(within(studio).getByRole('button', { name: /File:Elephant.png/ }));
    await screen.findByText(/بناء طبقات الشكل/);
    await waitFor(() => expect(within(screen.getByLabelText('3D viewport')).getByText(/بناء «فيل».*معاينة مؤقتة/)).toBeTruthy());
    expect(mock.mock.calls.filter(([url]) => url === '/api/image-pixels')).toHaveLength(1);
    // Switching panels must not cancel the running edit or put the draft in history.
    fireEvent.click(screen.getByRole('tab', { name: /^العناصر$/ }));
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
    fireEvent.change(screen.getByLabelText('وصف العالم'), { target: { value: 'شجرة' } });
    if (!(screen.getByLabelText('استخدام البناء المحلي فقط') as HTMLInputElement).checked) fireEvent.click(screen.getByLabelText('استخدام البناء المحلي فقط')); fireEvent.click(screen.getByRole('button', { name: 'إنشاء العالم' }));
    fireEvent.click(await screen.findByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), { target: { value: 'أضف فيل' } });
    fireEvent.click(screen.getByRole('button', { name: 'تطبيق التعديل' }));
    fireEvent.click(await screen.findByRole('button', { name:/File:Elephant.png/ }));
    await screen.findByText(/بناء طبقات الشكل/);
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), { target: { value: 'أضف صخرة' } });
    expect(await screen.findByText(/تغيّر العالم أو التحديد أو الأمر أثناء البناء/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /^العناصر$/ }));
    expect(within(screen.getByRole('tree', { name: 'Scene hierarchy' })).getAllByRole('treeitem')).toHaveLength(1);
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
    fireEvent.change(screen.getByLabelText('وصف العالم'), { target: { value: 'شجرة' } });
    if (!(screen.getByLabelText('استخدام البناء المحلي فقط') as HTMLInputElement).checked) fireEvent.click(screen.getByLabelText('استخدام البناء المحلي فقط')); fireEvent.click(screen.getByRole('button', { name: 'إنشاء العالم' }));
    fireEvent.click(await screen.findByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), { target: { value: 'أضف 2 فيل وزرافة' } });
    fireEvent.click(screen.getByRole('button', { name: 'تطبيق التعديل' }));
    fireEvent.click(await screen.findByRole('button', { name:/File:Elephant.png/ }));
    fireEvent.click(await screen.findByRole('button', { name:/File:Giraffe.png/ }, {timeout:5000}));
    expect(await screen.findByText(/أُضيفت مجسمات الصور التقريبية معاً/, {}, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /^العناصر$/ }));
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
    fireEvent.change(screen.getByLabelText('وصف العالم'), { target: { value: 'شجرة' } });
    if (!(screen.getByLabelText('استخدام البناء المحلي فقط') as HTMLInputElement).checked) fireEvent.click(screen.getByLabelText('استخدام البناء المحلي فقط')); fireEvent.click(screen.getByRole('button', { name: 'إنشاء العالم' }));
    fireEvent.click(await screen.findByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), { target: { value: 'أضف فيل وزرافة' } });
    fireEvent.click(screen.getByRole('button', { name: 'تطبيق التعديل' }));
    fireEvent.click(await screen.findByRole('button', { name:/File:Elephant.png/ }));
    fireEvent.click(await screen.findByRole('button', { name:/File:Giraffe.png/ }, {timeout:5000}));
    expect(await screen.findByText(/بيانات الصورة غير صالحة.*لم يُضف مجسم/, {}, { timeout:5000 })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء التعديل' }));
    expect(screen.getByText(/أُلغي التعديل؛ لم يتغير العالم/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /^العناصر$/ }));
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
    fireEvent.change(screen.getByLabelText('وصف العالم'), { target: { value: 'بيت' } });
    if (!(screen.getByLabelText('استخدام البناء المحلي فقط') as HTMLInputElement).checked) fireEvent.click(screen.getByLabelText('استخدام البناء المحلي فقط')); fireEvent.click(screen.getByRole('button', { name: 'إنشاء العالم' }));
    fireEvent.click(await screen.findByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), { target: { value: 'أضف فيل يمين البيت' } });
    fireEvent.click(screen.getByRole('button', { name: 'تطبيق التعديل' }));
    fireEvent.click(await screen.findByRole('button', { name:/File:Elephant.png/ }));
    expect(await screen.findByText(/أُضيف مجسم الصورة التقريبي في مكان متاح/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /^العناصر$/ }));
    expect(within(screen.getByRole('tree', {name:'Scene hierarchy'})).getAllByRole('treeitem')).toHaveLength(2);
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
      fireEvent.click(screen.getByRole('button', {name:'المحرر'}));
      const sheet = screen.getByRole('dialog', {name:'بناء وتعديل'});
      fireEvent.change(within(sheet).getByLabelText('تعديل العالم بالكتابة'), {target:{value:'أضف فيل'}});
      fireEvent.click(within(sheet).getByRole('button', {name:'تطبيق التعديل'}));
      fireEvent.click(await screen.findByRole('button', { name:/File:Elephant.png/ }));
      await screen.findByText(/بناء طبقات الشكل/);
      fireEvent.click(within(sheet).getByRole('button', {name:'Close panel'}));
      await waitFor(() => expect(within(screen.getByLabelText('3D viewport')).getByText(/بناء «فيل».*معاينة مؤقتة/)).toBeTruthy());
      fireEvent.click(within(screen.getByRole('navigation', {name:'Editor panels'})).getByRole('button', {name:'العناصر'}));
      const tree = within(screen.getByRole('dialog', {name:'العناصر'})).getByRole('tree', {name:'Scene hierarchy'});
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
    fireEvent.click(screen.getByRole('button', {name:'المحرر'}));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), {target:{value:'أضف فيل'}});
    fireEvent.click(screen.getByRole('button', {name:'تطبيق التعديل'}));
    fireEvent.click(await screen.findByRole('button', { name:/File:Elephant.png/ }));
    await screen.findByText(/بناء طبقات الشكل/);
    await waitFor(() => expect(within(screen.getByLabelText('3D viewport')).getByText(/بناء «فيل».*معاينة مؤقتة/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', {name:'إلغاء التعديل'}));
    expect(screen.getByText(/أُلغي التعديل؛ لم يتغير العالم/)).toBeTruthy();
    expect(within(screen.getByLabelText('3D viewport')).queryByText(/بناء «فيل».*معاينة مؤقتة/)).toBeNull();
    fireEvent.click(screen.getByRole('tab', {name:/^العناصر$/}));
    expect(within(screen.getByRole('tree', {name:'Scene hierarchy'})).queryByText('فيل')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(within(screen.getByRole('tree', {name:'Scene hierarchy'})).queryByText('فيل')).toBeNull();
  }, 20000);

  it('uses an exact Wikipedia definition for a safe undoable edit when images fail', async () => {
    const article = {title:'باوباب', url:'https://ar.wikipedia.org/wiki/باوباب', content:'الباوباب هي شجرة ضخمة.'};
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/online') return new Response('{"online":true}');
      if (url === '/api/search') return new Response(JSON.stringify({results:[article]}));
      if (url === '/api/wiki-article') return new Response(JSON.stringify({article}));
      if (url === '/api/image-search') return new Response('', {status:502});
      if (url === '/api/dictionary') return new Response('{"entries":[],"complete":true}');
      return new Response('{}');
    }));
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.change(screen.getByLabelText('وصف العالم'), {target:{value:'بيت'}});
    if (!(screen.getByLabelText('استخدام البناء المحلي فقط') as HTMLInputElement).checked) fireEvent.click(screen.getByLabelText('استخدام البناء المحلي فقط')); fireEvent.click(screen.getByRole('button', { name: 'إنشاء العالم' }));
    fireEvent.click(await screen.findByRole('button', {name:'فتح العالم في المحرر ←'}));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), {target:{value:'أضف باوباب يمين البيت'}});
    fireEvent.click(screen.getByRole('button', {name:'تطبيق التعديل'}));
    expect(await screen.findByText(/أُضيف «باوباب» كنموذج شجرة تقريبي من المقالة/)).toBeTruthy();
    expect(screen.getByText(/تعذّر البحث عن الصور في Wikimedia Commons/)).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', {name:/^العناصر$/}));
    const tree = screen.getByRole('tree', {name:'Scene hierarchy'});
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', {name:/Undo \(Ctrl\/Cmd\+Z\)/}));
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(1);
  }, 20000);

  it('shows the article but refuses to invent an unsupported animal when no photo exists', async () => {
    const article = {title:'فيل', url:'https://ar.wikipedia.org/wiki/فيل', content:'الفيل حيوان يعيش في الغابات.'};
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/search') return new Response(JSON.stringify({results:[article]}));
      if (url === '/api/wiki-article') return new Response(JSON.stringify({article}));
      if (url === '/api/image-search') return new Response('{"results":[]}');
      if (url === '/api/translate-en') return new Response('{"title":null}');
      if (url === '/api/dictionary') return new Response('{"entries":[],"complete":true}');
      return new Response('{}');
    }));
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.click(screen.getByRole('button', {name:'المحرر'}));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'), {target:{value:'أضف فيل'}});
    fireEvent.click(screen.getByRole('button', {name:'تطبيق التعديل'}));
    expect(await screen.findByText(/لم أجد صوراً مناسبة لـ «فيل»؛ لم يُنشأ/)).toBeTruthy();
    expect(screen.getByText('الفيل حيوان يعيش في الغابات.')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', {name:/^العناصر$/}));
    expect(within(screen.getByRole('tree', {name:'Scene hierarchy'})).queryByText('فيل')).toBeNull();
  }, 20000);

  it('refuses to insert a terrain photograph into an existing map', async () => {
    const article={title:'كالديرا',url:'https://ar.wikipedia.org/wiki/كالديرا',content:'الكالديرا هي تضاريس.'};
    const image={title:'File:Crater.jpg',url:'https://commons.wikimedia.org/wiki/File:Crater.jpg',thumbnail:'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Crater.jpg/250px-Crater.jpg',author:'A',license_url:'https://creativecommons.org/licenses/by/4.0/',license_name:'CC BY 4.0'};
    vi.stubGlobal('fetch',vi.fn(async (url:string) => {
      if(url==='/api/search') return new Response(JSON.stringify({results:[article]}));
      if(url==='/api/wiki-article') return new Response(JSON.stringify({article}));
      if(url==='/api/image-search') return new Response(JSON.stringify({results:[image]}));
      return new Response('{}');
    }));
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fireEvent.click(screen.getByRole('button',{name:'المحرر'}));
    fireEvent.change(screen.getByLabelText('تعديل العالم بالكتابة'),{target:{value:'أضف تضاريس كالديرا'}});
    fireEvent.click(screen.getByRole('button',{name:'تطبيق التعديل'}));
    expect(await screen.findByText(/صُنّف تضاريس، وليس جسماً منفرداً/)).toBeTruthy();
    expect(screen.getByText(/لم يتغير العالم/)).toBeTruthy();
    expect(screen.queryByRole('region',{name:'استوديو تقريب الصورة'})).toBeNull();
  },20000);


  it('builds locally with no network requests even when asked to search and warns about unsupported terms', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fetchMock.mockClear();
    fireEvent.change(screen.getByLabelText('وصف العالم'), { target: { value: 'ابحث عن غابة فيها بيت وفيل' } });
    if (!(screen.getByLabelText('استخدام البناء المحلي فقط') as HTMLInputElement).checked) fireEvent.click(screen.getByLabelText('استخدام البناء المحلي فقط')); fireEvent.click(screen.getByRole('button', { name: 'إنشاء العالم' }));
    expect(await screen.findByText('World generated')).toBeTruthy();
    expect(screen.getByText(/قد لا يفهم البناء النصي.*فيل/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'نتائج البحث التلقائي' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'استوديو تقريب الصورة' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  }, 20000);
  it('does not show an unsupported-word warning for normal supported Arabic and remains usable offline', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    fetchMock.mockClear();
    fireEvent.change(screen.getByLabelText('وصف العالم'), { target: { value: 'غابة فيها بيت و3 أشجار' } });
    if (!(screen.getByLabelText('استخدام البناء المحلي فقط') as HTMLInputElement).checked) fireEvent.click(screen.getByLabelText('استخدام البناء المحلي فقط')); fireEvent.click(screen.getByRole('button', { name: 'إنشاء العالم' }));
    expect(await screen.findByText('World generated')).toBeTruthy();
    expect(screen.queryByText(/قد لا يفهم البناء النصي/)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'فتح العالم في المحرر ←' }));
    fireEvent.click(screen.getByRole('tab', { name: /^العناصر$/ }));
    expect(within(screen.getByRole('tree', { name: 'Scene hierarchy' })).getAllByRole('treeitem').length).toBeGreaterThan(4);
  }, 20000);

  it('does not replace the world when the prompt changes before local generation finishes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    render(<App />);
    await waitFor(() => expect((screen.getByLabelText('World name') as HTMLInputElement).value).not.toBe('Loading…'));
    const name = (screen.getByLabelText('World name') as HTMLInputElement).value;
    const prompt = screen.getByLabelText('وصف العالم');
    fireEvent.change(prompt, { target: { value: 'غابة فيها بيت' } });
    if (!(screen.getByLabelText('استخدام البناء المحلي فقط') as HTMLInputElement).checked) fireEvent.click(screen.getByLabelText('استخدام البناء المحلي فقط')); fireEvent.click(screen.getByRole('button', { name: 'إنشاء العالم' }));
    fireEvent.change(prompt, { target: { value: 'صحراء' } });
    expect((await screen.findByRole('alert')).textContent).toContain('تغيّر العالم أو الوصف');
    expect(screen.queryByText('World generated')).toBeNull();
    expect((screen.getByLabelText('World name') as HTMLInputElement).value).toBe(name);
  }, 20000);

});
