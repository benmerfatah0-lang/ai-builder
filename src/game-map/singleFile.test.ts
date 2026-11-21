import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

/**
 * Guards the zero-install deliverable: `map-3d.html`.
 *
 * The whole point of that file is that a reviewer can download it and double
 * click it - no server, no npm, no network. Every property below is something
 * that would silently break that promise, and each one has broken at least once
 * in a comparable single-file build:
 *
 *  - a `type="module"` script is refused by browsers over `file://` (CORS)
 *  - a sibling `./map.js` / `./map.css` reference means it is not one file
 *  - an unescaped `</script>` inside the bundle closes the tag early and the
 *    rest of the app is rendered as text
 */
const PATH = 'map-3d.html';

const read = () => readFileSync(PATH, 'utf8');

describe('single-file map deliverable', () => {
  it('exists and is one self-contained document', () => {
    expect(existsSync(PATH), `${PATH} is missing - run npm run build:single`).toBe(true);
    const html = read();
    expect(html).toContain('id="root"');
    expect(html).toContain('dir="rtl"');
    // Nothing may be loaded from beside the file.
    expect(html).not.toMatch(/(?:src|href)="\.\/[^"]+"/);
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"[^>]*href="(?!data:)[^"]+"/);
  });

  it('never uses an ES module script, which file:// cannot load', () => {
    const html = read();
    // Vite's default output is `type="module"`, and it silently produces a page
    // that shows nothing at all when opened from disk.
    expect(html).not.toContain('type="module"');
  });

  it('inlines exactly one script and one stylesheet', () => {
    const html = read();
    // Counted the way a browser does: the bundle is JS, so a `<style>` inside a
    // template string (the paper map's inline SVG has one) is just text and must
    // not be mistaken for a second element. Only the real <script> and <style>
    // that this build writes sit outside any script content.
    const bundleStart = html.indexOf('<script>');
    expect(bundleStart, 'the inlined bundle is missing').toBeGreaterThan(-1);
    const bundleEnd = html.indexOf('</script>', bundleStart);
    expect(bundleEnd).toBeGreaterThan(bundleStart);
    const outsideBundle = html.slice(0, bundleStart) + html.slice(bundleEnd);

    expect(outsideBundle.match(/<script(?![^>]*src=)/g)?.length ?? 0, 'extra inline scripts').toBe(0);
    // Two: the app's own CSS (kept after the gallery so the gallery is not
    // hidden behind a full-viewport layout) and the gallery's CSS.
    expect(outsideBundle.match(/<style/g)?.length ?? 0, 'inline stylesheets').toBe(2);
    // The bundle must not contain a bare closing tag, or it escapes its element.
    expect(html.match(/<\/script>/g)?.length ?? 0, 'script closers').toBe(1);
  });

  it('ships the real scene, not a placeholder', () => {
    const html = read();
    // The backdrop work is only in the file if the hills palette is. Read the
    // palette from source rather than hard-coding a hex: the band colours were
    // retuned twice while the hills grew, and the test kept failing over a colour
    // that no longer meant anything.
    const palette = readFileSync(new URL('./scene.ts', import.meta.url), 'utf8')
      .match(/HILL_COLORS = \{([^}]*)\}/);
    expect(palette, 'HILL_COLORS is gone from scene.ts').toBeTruthy();
    const bands = [...palette![1]!.matchAll(/'#([0-9a-f]{6})'/g)].map((hit) => hit[1]);
    expect(bands.length, 'no hill band colours found').toBeGreaterThan(2);
    for (const band of bands) expect(html, `hill band #${band} is not in the file`).toContain(band);
    expect(html).toContain('hill-ground');
    expect(html).toContain('distant-hills');
    // And the app itself must actually be bundled.
    expect(html).toContain('createRoot');
  });

  it('asks for nothing over the network, so it opens on a phone with no signal', () => {
    const html = read();
    // The single file is the offline deliverable. A leftover <link> to a font host
    // held the whole stylesheet hostage to a request that could never resolve.
    const external = [...html.matchAll(/(?:src|href)\s*=\s*"(https?:\/\/[^"]+)"/g)].map(
      (hit) => hit[1]!,
    );
    expect(external, 'the one-file build still fetches from the network').toEqual([]);
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).not.toContain('fonts.gstatic.com');
  });

  it('shows the map as pictures even when JavaScript never runs', () => {
    // Android Chrome refuses to execute scripts for a document opened from
    // content://media/external (what the Files app hands over when you tap a
    // downloaded .html). The page then shows its title and a blank body, which
    // looks exactly like a broken map. The gallery must therefore be plain
    // markup that needs no script at all.
    const html = read();

    // Every picture is embedded, so none can fail to load beside the file.
    const images = html.match(/<img\s[^>]*src="data:image\/jpeg;base64,/g) ?? [];
    expect(images.length, 'the no-JS gallery is missing its renders').toBeGreaterThanOrEqual(7);

    // The gallery must sit before the script, so it paints during parse.
    const galleryAt = html.indexOf('class="nojs-gallery"');
    // The bundle is the only script and it starts with an IIFE, so anchor on
    // that instead of a bare `<script>`: base64 image data can contain the
    // literal characters `<script>` and would produce a false match.
    const scriptAt = html.indexOf('<script>\n(function(){');
    expect(scriptAt, 'could not locate the inlined bundle').toBeGreaterThan(-1);
    expect(galleryAt, 'gallery not found').toBeGreaterThan(-1);
    expect(galleryAt, 'gallery must come before the bundle').toBeLessThan(scriptAt);

    // And it must explain itself rather than looking like a downgrade.
    expect(html).toContain('content://');
    expect(html).toMatch(/<h1[^>]*>زعتر والحضيرة العظمى<\/h1>/);
  });

  it('does not block first paint on a network font', () => {
    const html = read();
    // Google Fonts still loads when online, but a preconnect there makes the
    // offline file wait on a host it cannot reach.
    expect(html).not.toContain('rel="preconnect"');
  });
});
