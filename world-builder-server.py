#!/usr/bin/env python3
"""Loopback-only phone server with fixed Wikipedia endpoints; no API keys."""
import argparse
import base64
import io
import json
import os
import re
import sys
from functools import partial
from wiki_learner import WikiLearner
from house_learner import HouseLearner, good_thumb, good_source, plain, LICENSE_PATTERN
from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, build_opener, HTTPRedirectHandler

MAX_REQUEST = 64 * 1024
MAX_RESPONSE = 2 * 1024 * 1024
USER_AGENT = 'AIWorldBuilder/1.0 (https://github.com/benmerfatah0-lang/ai-builder)'
ONLINE_URL = 'https://ar.wikipedia.org/w/api.php?action=query&meta=siteinfo&siprop=general&format=json'
COMMONS_API = 'https://commons.wikimedia.org/w/api.php?'
DICTIONARY_API = 'https://en.wiktionary.org/api/rest_v1/page/definition/'


def search_image_references(query):
    # Never accept a URL from the client; the sole upstream is the fixed Commons API.
    params = urlencode({'action': 'query', 'format': 'json', 'formatversion': 2,
                        'generator': 'search', 'gsrnamespace': 6, 'gsrlimit': 15,
                        'gsrsearch': query + ' filetype:bitmap', 'prop': 'imageinfo',
                        'iiprop': 'url|mime|extmetadata', 'iiurlwidth': 240})
    data = get_json(Request(COMMONS_API + params, headers={'User-Agent': USER_AGENT}), timeout=25)
    if not isinstance(data, dict) or 'error' in data or not isinstance(data.get('query', {}), dict):
        raise ValueError('invalid Commons response')
    pages = data.get('query', {}).get('pages', [])
    if not isinstance(pages, list): raise ValueError('invalid Commons pages')
    results, seen = [], set()
    for page in pages[:15]:
        if not isinstance(page, dict): continue
        title, infos = page.get('title'), page.get('imageinfo')
        if not isinstance(title, str) or not title.startswith('File:') or not isinstance(infos, list) or not infos or not isinstance(infos[0], dict): continue
        info = infos[0]
        if info.get('mime') not in ('image/jpeg', 'image/png'): continue
        metadata = info.get('extmetadata')
        if not isinstance(metadata, dict): continue
        def meta(key):
            entry = metadata.get(key)
            return entry.get('value', '') if isinstance(entry, dict) else ''
        license_url = meta('LicenseUrl')
        author = plain(meta('Artist'))
        thumb = info.get('thumburl')
        source = 'https://commons.wikimedia.org/wiki/' + quote(title.replace(' ', '_'), safe='/:_()-')
        if not isinstance(license_url, str) or not LICENSE_PATTERN.fullmatch(license_url): continue
        if not good_source(source) or len(source) > 1200 or source in seen or not good_thumb(thumb) or len(thumb) > 1200: continue
        # Only bounded Commons-generated 240px thumbnails, never an original upload.
        if not thumb.startswith('https://upload.wikimedia.org/wikipedia/commons/thumb/') or '/240px-' not in thumb: continue
        if '/licenses/' in license_url and not author: continue
        seen.add(source)
        results.append({'title': title[:120], 'url': source, 'thumbnail': thumb,
                        'author': author or 'Not specified', 'license_url': license_url.replace('http://', 'https://', 1),
                        'license_name': ('CC0' if '/publicdomain/zero/' in license_url else 'CC ' + ('BY-SA' if '/by-sa/' in license_url else 'BY') + ' ' + license_url.rstrip('/').split('/')[-1])})
        if len(results) == 8: break
    return results


def dictionary_definitions(word):
    # The multilingual sections of the English Wiktionary's experimental
    # definition API; glosses are generally in English. Never accept a URL.
    if not isinstance(word, str) or not re.fullmatch(r'[^\W\d_]{2,80}', word, re.UNICODE):
        raise ValueError('single word required')
    try:
        data = get_json(Request(DICTIONARY_API + quote(word, safe=''), headers={'User-Agent': USER_AGENT, 'Accept': 'application/json'}), timeout=25)
    except HTTPError as error:
        if error.code == 404:
            return {'entries': [], 'complete': True}
        raise
    if not isinstance(data, dict):
        raise ValueError('invalid dictionary response')
    entries, complete = [], True
    for language in ('ar', 'fr', 'en'):
        blocks = data.get(language, [])
        if not isinstance(blocks, list): raise ValueError('invalid dictionary language')
        if len(blocks) > 8: complete = False
        for block in blocks[:8]:
            if not isinstance(block, dict) or not isinstance(block.get('definitions'), list) or not isinstance(block.get('partOfSpeech'), str):
                complete = False
                continue
            definitions = block['definitions']
            if len(definitions) > 8: complete = False
            for sense in definitions[:8]:
                if not isinstance(sense, dict) or not isinstance(sense.get('definition'), str):
                    complete = False
                    continue
                definition = strip_html(sense['definition']).strip()
                if not definition: complete = False; continue
                if len(definition) > 400: complete = False
                entries.append({'language': language, 'partOfSpeech': block['partOfSpeech'][:80], 'definition': definition[:400]})
    return {'entries': entries, 'complete': complete}


def analyze_reference_image(url):
    # Only bounded thumbnail URLs on Wikimedia's fixed upload host are accepted.
    if not isinstance(url, str) or len(url) > 1200 or not good_thumb(url) or not url.startswith('https://upload.wikimedia.org/wikipedia/commons/thumb/') or '/240px-' not in url:
        raise ValueError('invalid thumbnail')
    try:
        from PIL import Image, ImageStat
    except ImportError as error:
        raise RuntimeError('missing pillow') from error
    raw = get_image(Request(url, headers={'User-Agent': USER_AGENT}), timeout=25)
    with Image.open(io.BytesIO(raw)) as image:
        if image.format not in ('JPEG', 'PNG') or image.width < 1 or image.height < 1 or image.width * image.height > 1_000_000:
            raise ValueError('invalid image')
        image.load()
        image.thumbnail((64, 64))
        rgba = image.convert('RGBA')
        background = Image.new('RGBA', rgba.size, (255, 255, 255, 255))
        rgb = Image.alpha_composite(background, rgba).convert('RGB')
        w, h = rgb.size
        # This is the central area of the entire photo, not object segmentation.
        crop = rgb.crop((w // 4, h // 4, max(w // 4 + 1, w * 3 // 4), max(h // 4 + 1, h * 3 // 4)))
        color = '#' + ''.join(f'{max(0, min(255, round(v))):02x}' for v in ImageStat.Stat(crop).mean[:3])
        return {'center_color': color}


def reference_image_pixels(url):
    """Return only a tiny image for a lossy silhouette approximation; no original saved."""
    if not isinstance(url, str) or len(url) > 1200 or not good_thumb(url) or not url.startswith('https://upload.wikimedia.org/wikipedia/commons/thumb/') or '/240px-' not in url:
        raise ValueError('invalid thumbnail')
    try:
        from PIL import Image
    except ImportError as error:
        raise RuntimeError('missing pillow') from error
    raw = get_image(Request(url, headers={'User-Agent': USER_AGENT}), timeout=25)
    with Image.open(io.BytesIO(raw)) as image:
        if image.format not in ('JPEG', 'PNG') or image.width < 1 or image.height < 1 or image.width * image.height > 1_000_000:
            raise ValueError('invalid image')
        image.load()
        image.thumbnail((24, 24))
        rgba = image.convert('RGBA')
        return {'width': rgba.width, 'height': rgba.height, 'rgba': base64.b64encode(rgba.tobytes()).decode('ascii')}



class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
    def handle_data(self, data):
        self.parts.append(data)


def strip_html(text):
    parser = PlainText()
    parser.feed(text)
    return ''.join(parser.parts)[:1200]


def get_json(request, timeout):
    with build_opener(NoRedirects()).open(request, timeout=timeout) as response:
        body = response.read(MAX_RESPONSE + 1)
        if len(body) > MAX_RESPONSE:
            raise ValueError('response too large')
        return json.loads(body)


def get_image(request, timeout):
    if not good_thumb(request.full_url):
        raise ValueError('untrusted image URL')
    with build_opener(NoRedirects()).open(request, timeout=timeout) as response:
        if response.headers.get_content_type() not in ('image/jpeg', 'image/png'):
            raise ValueError('unsupported content type')
        body = response.read(1_000_001)
        if len(body) > 1_000_000:
            raise ValueError('image too large')
        return body


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        # Prompts and URLs may contain personal data; do not log requests.
        pass

    def api_result(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-World-Builder-Proxy', '1')
        self.end_headers()
        self.wfile.write(body)

    def valid_host(self):
        port = self.server.server_address[1]
        return self.headers.get('Host', '') in {f'127.0.0.1:{port}', f'localhost:{port}'}

    def do_GET(self):
        if not self.valid_host() or self.path != '/world-builder-mobile.html':
            self.send_error(404)
            return
        super().do_GET()

    def do_HEAD(self):
        if not self.valid_host() or self.path != '/world-builder-mobile.html':
            self.send_error(404)
            return
        super().do_HEAD()

    def do_POST(self):
        host = self.headers.get('Host', '')
        if not self.valid_host() or self.headers.get('Origin', '') != f'http://{host}':
            self.api_result(403, {'error': 'invalid origin'})
            return
        if self.path not in ('/api/online', '/api/search', '/api/image-search', '/api/image-analyze', '/api/image-pixels', '/api/dictionary', '/api/knowledge', '/api/house-learning'):
            self.api_result(404, {'error': 'unknown endpoint'})
            return
        if self.headers.get_content_type() != 'application/json':
            self.api_result(415, {'error': 'JSON required'})
            return
        try:
            length = int(self.headers.get('Content-Length', '-1'))
            if length < 1 or length > MAX_REQUEST:
                raise ValueError('invalid length')
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError('object required')
        except (ValueError, UnicodeError):
            self.api_result(400, {'error': 'invalid request'})
            return
        try:
            if self.path == '/api/house-learning':
                self.api_result(200, self.server.house_learner.snapshot())
                return
            if self.path == '/api/knowledge':
                self.api_result(200, self.server.wiki_learner.snapshot())
                return
            if self.path == '/api/online':
                response = get_json(Request(ONLINE_URL, headers={'User-Agent': USER_AGENT}), timeout=25)
                if not isinstance(response, dict) or 'query' not in response:
                    raise ValueError('invalid connectivity response')
                self.api_result(200, {'online': True})
                return
            if self.path in ('/api/image-analyze', '/api/image-pixels'):
                if not isinstance(payload.get('url'), str) or not good_thumb(payload['url']) or not payload['url'].startswith('https://upload.wikimedia.org/wikipedia/commons/thumb/') or '/240px-' not in payload['url'] or len(payload['url']) > 1200:
                    self.api_result(400, {'error': 'invalid thumbnail'})
                    return
                try:
                    result = analyze_reference_image(payload['url']) if self.path == '/api/image-analyze' else reference_image_pixels(payload['url'])
                except RuntimeError:
                    self.api_result(503, {'error': 'missing_pillow'})
                    return
                except Exception:
                    self.api_result(502, {'error': 'image_analysis_failed'})
                    return
                self.api_result(200, result)
                return
            query = payload.get('query')
            if not isinstance(query, str) or not query.strip() or len(query) > 400:
                self.api_result(400, {'error': 'invalid query'})
                return
            if self.path == '/api/dictionary':
                word = query.strip()
                if not re.fullmatch(r'[^\W\d_]{2,80}', word, re.UNICODE):
                    self.api_result(400, {'error': 'single word required'})
                    return
                self.api_result(200, dictionary_definitions(word))
                return
            if self.path == '/api/image-search':
                self.api_result(200, {'results': search_image_references(query.strip())})
                return
            language = 'ar' if re.search(r'[\u0600-\u06ff]', query) else 'en'
            hostname = f'{language}.wikipedia.org'
            target = f'https://{hostname}/w/rest.php/v1/search/page?' + urlencode({'q': query, 'limit': 4})
            response = get_json(Request(target, headers={'User-Agent': USER_AGENT}), timeout=25)
            if not isinstance(response, dict) or not isinstance(response.get('pages'), list):
                raise ValueError('invalid search response')
            results = []
            for page in response['pages'][:4]:
                if not isinstance(page, dict):
                    continue
                title, key = page.get('title'), page.get('key')
                if not isinstance(title, str) or not isinstance(key, str) or not key:
                    continue
                excerpt = page.get('excerpt') or page.get('description') or ''
                if not isinstance(excerpt, str):
                    excerpt = ''
                results.append({'title': title[:120], 'url': f'https://{hostname}/wiki/{quote(key, safe="/_():-")}',
                                'content': strip_html(excerpt)})
            self.api_result(200, {'results': results})
        except (HTTPError, URLError, TimeoutError, OSError, ValueError, UnicodeError):
            self.api_result(502, {'error': 'service unavailable'})


def main():
    parser = argparse.ArgumentParser(description='World Builder local phone server')
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--directory', default=os.path.dirname(os.path.abspath(__file__)))
    args = parser.parse_args()
    handler = partial(Handler, directory=args.directory)
    with ThreadingHTTPServer(('127.0.0.1', args.port), handler) as server:
        server.wiki_learner = WikiLearner(args.directory, get_json, USER_AGENT)
        server.wiki_learner.start()
        server.house_learner = HouseLearner(args.directory, get_json, get_image, USER_AGENT)
        server.house_learner.start()
        print('التعلم المحدود من ويكيبيديا وصور البيوت يعمل أثناء بقاء Termux شغالاً (يتطلب الصور python-pillow).', flush=True)
        print(f'افتح http://127.0.0.1:{args.port}/world-builder-mobile.html', flush=True)
        print('لإيقاف الخادم اضغط Ctrl+C.', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.wiki_learner.stop()
            server.house_learner.stop()
    return 0


if __name__ == '__main__':
    sys.exit(main())
