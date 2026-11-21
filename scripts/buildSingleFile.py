"""Build `map-3d.html`: the 3D map plus a always-visible picture gallery.

Why the gallery exists
----------------------
Android Chrome refuses to run JavaScript for a document opened from
`content://media/external/...` (which is what the Downloads/Files app hands it
when you tap a downloaded `.html`). The page then renders its HTML and stops:
the title shows, the body is blank, and no error is displayed. That looks
exactly like a broken map.

So the page must be useful with **zero JavaScript**:

  * a complete gallery of the seven rendered views is pure HTML + inline
    `data:` images, so it paints no matter what
  * the interactive 3D map is added on top only if scripting is allowed

Nothing here fetches a sibling file, and nothing depends on the origin being
`file://`, `content://` or `http://`.
"""
import base64
import json
from pathlib import Path

DIST = Path('dist-single')
OUT = Path('map-3d.html')

# Order matters: it is the journey through the level.
VIEWS = [
    ('overview', 'نظرة عامة', 'الديوراما كاملة: المناطق الخمس، المسار الرئيسي، وستّة وعشرون معلمًا.'),
    ('top', 'من أعلى', 'مخطّط عمودي يكشف شبكة الطرق والمسافات بين الحصون.'),
    ('start', 'البداية · حافّة الغابة', 'نقطة الهبوط جنوبًا: بوابة المحجر، ثم أول منعطف نحو المزرعة.'),
    ('farm', 'المزرعة', 'الحقل المفتوح، الطاحونة، والحظيرة الرئيسية.'),
    ('crops', 'الزراعة', 'شبكة الحقول والممرات المائية وقنوات الري.'),
    ('pens', 'الحظائر', 'الجسر الخشبي فوق النهر وأحواض الحظائر.'),
    ('finale', 'القصر · الخاتمة', 'حلبة الخاتمة أمام قصر الحضيرة، وتلال الأفق خلفها.'),
]

GALLERY_CSS = """
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    html, body { margin: 0; background: #14100c; }
    body {
      font-family: 'Noto Naskh Arabic', 'Segoe UI', system-ui, sans-serif;
      color: #f3e9d8;
    }
    .nojs-gallery { direction: rtl; padding: 28px 20px 12px; max-width: 1180px; margin: 0 auto; }
    .nojs-gallery h1 { font-size: clamp(24px, 5vw, 40px); margin: 0 0 6px; color: #ffd98a; }
    .nojs-gallery p.lede { margin: 0 0 22px; color: #b9ab97; font-size: 15px; line-height: 1.8; }
    .nojs-gallery .banner {
      border: 1px solid #4b3c28; background: #1d1710; border-radius: 12px;
      padding: 14px 16px; margin: 0 0 24px; font-size: 14px; line-height: 1.9; color: #d9c9b0;
    }
    .nojs-gallery .banner strong { color: #ffd98a; }
    .nojs-gallery figure {
      margin: 0 0 30px; background: #1b1611; border: 1px solid #3a2f22;
      border-radius: 14px; overflow: hidden;
    }
    .nojs-gallery img { display: block; width: 100%; height: auto; }
    .nojs-gallery figcaption {
      padding: 12px 16px 16px; font-size: 14px; line-height: 1.75; color: #b9ab97;
    }
    .nojs-gallery figcaption b { display: block; color: #ffd98a; font-size: 17px; margin-bottom: 4px; }
    .nojs-gallery .foot { color: #7d7060; font-size: 13px; padding: 6px 0 34px; line-height: 1.8; }
"""

INTERACTIVE_CSS = """
    /* The 3D app owns the viewport once it boots; the gallery stays below it so
       a visitor can scroll down even if WebGL is unavailable. */
    #root:not(:empty) { min-height: 100vh; }
    #root:not(:empty) ~ .nojs-gallery { border-top: 1px solid #3a2f22; }
"""


def jpeg_data_uri(path: Path) -> str:
    return 'data:image/jpeg;base64,' + base64.b64encode(path.read_bytes()).decode()


def gallery_html() -> str:
    figures = []
    for name, title, blurb in VIEWS:
        image = Path('docs/game-map') / f'{name}.jpg'
        if not image.exists():
            raise SystemExit(f'missing render: {image}')
        figures.append(
            f'      <figure>\n'
            f'        <img src="{jpeg_data_uri(image)}" alt="{title}" '
            f'width="1400" height="900" loading="lazy" decoding="async" />\n'
            f'        <figcaption><b>{title}</b>{blurb}</figcaption>\n'
            f'      </figure>'
        )
    return '\n'.join(figures)


def main() -> None:
    html = (DIST / 'game-map.html').read_text(encoding='utf-8')
    js = (DIST / 'map.js').read_text(encoding='utf-8')
    css = (DIST / 'map.css').read_text(encoding='utf-8')
    icon = (DIST / 'favicon.svg').read_bytes()

    # A literal </script> inside the JS would close the element early. Both
    # spellings are folded because a bundler may emit either.
    js = js.replace('</script', '<\\/script')
    js = js.replace('<\/script', '<\\/script')

    # Move the bundle out of <head> and to the very end of <body>, after the
    # gallery. Two reasons: the pictures must paint even if the script is slow,
    # blocked, or crashes; and a script in <head> is parser-blocking, so the
    # gallery would only appear after a 1 MB bundle had been parsed.
    html = html.replace('<script type="module" crossorigin src="./map.js"></script>', '')
    html = html.replace(
        '</body>',
        '<script>\n' + js + '\n</script>\n</body>',
    )
    # CSS goes to the end of <body> (after the gallery) so the pictures are not
    # hidden behind the app's full-viewport layout when JS is blocked.
    html = html.replace('<link rel="stylesheet" crossorigin href="./map.css">', '')
    html = html.replace(
        '</body>',
        '<style>\n' + css + '\n' + INTERACTIVE_CSS + '</style>\n'
        '<style>' + GALLERY_CSS + '</style>\n'
        '</body>',
    )
    html = html.replace(
        '<link rel="icon" type="image/svg+xml" href="./favicon.svg" />',
        '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,'
        + base64.b64encode(icon).decode() + '" />',
    )
    # Offline first paint must not wait on a font host it cannot reach.
    html = html.replace(
        '<link rel="preconnect" href="https://fonts.googleapis.com" />\n    ', '')
    html = html.replace(
        '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />\n    ', '')

    # The gallery is the very first thing in <body>, before #root, so it paints
    # during parse and cannot depend on any script having run.
    gallery = (
        '<main class="nojs-gallery">\n'
        '  <h1>زعتر والحضيرة العظمى</h1>\n'
        '  <p class="lede">خريطة العالم ثلاثية الأبعاد — المزرعة، الزراعة، الحظائر، والقصر.'
        ' المناظر السبعة أدناه هي الماب نفسه بأعلى جودة، بلا حاجة إلى تشغيل أي شيء.</p>\n'
        '  <div class="banner">\n'
        '    <strong>لماذا تظهر صور بدلًا من الماب الحيّ؟</strong><br />\n'
        '    فتحتَ الملف من تطبيق الملفات، وهو يعطيه مسار <code>content://</code> —'
        ' وكروم يمنع تنفيذ JavaScript في هذا المسار. الماب التفاعلي يحتاج JavaScript،'
        ' لذا يبقى معطّلًا وتظهر هذه الصور بدلًا منه. الصور هي الخريطة الحقيقية بكل التفاصيل.<br /><br />\n'
        '    <strong>لترى الماب حيًّا:</strong> افتح الملف بمتصفّح من داخل تطبيق مثل'
        ' <em>Total Commander</em> أو <em>Files by Google</em> باختيار «فتح باستخدام ← كروم»،'
        ' أو شغّله من خادم محلّي (انظر <code>docs/SEE-THE-MAP.md</code>).\n'
        '  </div>\n'
        + gallery_html() + '\n'
        '  <p class="foot">تُعاد هذه الصور بتوليد آليّ من المشهد نفسه عبر '
        '<code>npm run map:render</code>، فلا تنفصل عن الماب أبدًا.</p>\n'
        '</main>\n'
    )
    marker = '<div id="root"></div>'
    if marker not in html:
        raise SystemExit('no #root marker')
    html = html.replace(marker, marker + '\n' + gallery, 1)

    assert 'type="module"' not in html, 'module script survived'
    assert 'src="./map.js"' not in html
    assert 'href="./map.css"' not in html

    OUT.write_text(html, encoding='utf-8')
    print(f'wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB, one file)')

    # Note: no duplicate is written into docs/. map-3d.html is already two
    # megabytes, and committing a byte-identical copy doubles the repo for no
    # benefit - the same file simply serves both download and direct open.


if __name__ == '__main__':
    main()
