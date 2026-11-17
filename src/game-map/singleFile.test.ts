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
    expect(outsideBundle.match(/<style/g)?.length ?? 0, 'inline stylesheets').toBe(1);
    // The bundle must not contain a bare closing tag, or it escapes its element.
    expect(html.match(/<\/script>/g)?.length ?? 0, 'script closers').toBe(1);
  });

  it('ships the real scene, not a placeholder', () => {
    const html = read();
    // The backdrop work is only in the file if the hills palette is.
    expect(html).toContain('#4f8238');
    expect(html).toContain('hill-ground');
    expect(html).toContain('distant-hills');
    // And the app itself must actually be bundled.
    expect(html).toContain('createRoot');
  });

  it('does not block first paint on a network font', () => {
    const html = read();
    // Google Fonts still loads when online, but a preconnect there makes the
    // offline file wait on a host it cannot reach.
    expect(html).not.toContain('rel="preconnect"');
  });
});
