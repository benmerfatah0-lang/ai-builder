"""Fold dist-single/ into one self-contained HTML file that runs over file://."""
import base64
from pathlib import Path

dist = Path('dist-single')
html = (dist / 'game-map.html').read_text(encoding='utf-8')

js = (dist / 'map.js').read_text(encoding='utf-8')
css = (dist / 'map.css').read_text(encoding='utf-8')
icon = (dist / 'favicon.svg').read_bytes()

# A literal </script> inside the JS would close the tag early.
js = js.replace('</script>', '<\\/script>')

html = html.replace(
    '<script type="module" crossorigin src="./map.js"></script>',
    '<script>\n' + js + '\n</script>',
)
html = html.replace(
    '<link rel="stylesheet" crossorigin href="./map.css">',
    '<style>\n' + css + '\n</style>',
)
# Inline the icon too, so the result is exactly one file.
html = html.replace(
    '<link rel="icon" type="image/svg+xml" href="./favicon.svg" />',
    '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,'
    + base64.b64encode(icon).decode() + '" />',
)
# A double-clicked file has no network guarantee; don't block first paint on
# Google Fonts. They still load when online and fall back otherwise.
html = html.replace(
    '<link rel="preconnect" href="https://fonts.googleapis.com" />\n    ', '')
html = html.replace(
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />\n    ', '')

assert 'type="module"' not in html, 'module script survived'
assert 'href="./map.css"' not in html
assert 'src="./map.js"' not in html

out = Path('map-3d.html')
out.write_text(html, encoding='utf-8')
print(f'wrote {out} ({out.stat().st_size/1024:.0f} KB, one file)')
