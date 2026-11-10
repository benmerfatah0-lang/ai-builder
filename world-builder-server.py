#!/usr/bin/env python3
"""Loopback-only phone server with fixed Wikipedia endpoints; no API keys."""
import argparse
import base64
import io
import json
import os
import re
import sys
import threading
import time
from functools import partial
from concurrent.futures import ThreadPoolExecutor
from wiki_learner import WikiLearner
from house_learner import HouseLearner, good_thumb, good_source, plain, LICENSE_PATTERN
from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit, parse_qs, urlunsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

MAX_REQUEST = 64 * 1024
MAX_RESPONSE = 2 * 1024 * 1024
USER_AGENT = 'AIWorldBuilder/1.0 (https://github.com/benmerfatah0-lang/ai-builder)'
CLOUD_3D_URL = 'https://hysts-shap-e.hf.space'
ASSET_SEARCH_URL = 'https://3dassets.dev/api/v1/assets'
ASSET_CDN_URL = 'https://cdn.3dassets.dev'
MAX_LIBRARY_MODEL = 2_000_000
CLOUD_3D_LOCK = threading.Lock()
MAX_CLOUD_3D = 12_000_000
ONLINE_URL = 'https://ar.wikipedia.org/w/api.php?action=query&meta=siteinfo&siprop=general&format=json'
COMMONS_API = 'https://commons.wikimedia.org/w/api.php?'
DICTIONARY_API = 'https://en.wiktionary.org/api/rest_v1/page/definition/'


def search_image_references(query, offset=0):
    # Never accept a URL from the client; the sole upstream is the fixed Commons API.
    params = urlencode({'action': 'query', 'format': 'json', 'formatversion': 2,
                        'generator': 'search', 'gsrnamespace': 6, 'gsrlimit': 15,
                        'gsrsearch': query + ' filetype:bitmap', 'prop': 'imageinfo',
                        'iiprop': 'url|mime|extmetadata', 'iiurlwidth': 240})
    if offset:
        params += '&' + urlencode({'gsroffset': offset, 'continue': 'gsroffset||'})
    data = get_json(Request(COMMONS_API + params, headers={'User-Agent': USER_AGENT}), timeout=25)
    if not isinstance(data, dict) or 'error' in data or not isinstance(data.get('query', {}), dict):
        raise ValueError('invalid Commons response')
    pages = data.get('query', {}).get('pages', [])
    if not isinstance(pages, list): raise ValueError('invalid Commons pages')
    results, seen = [], set()
    pages = sorted(pages[:15], key=lambda page: page.get('index', 2147483647) if isinstance(page, dict) and type(page.get('index')) is int else 2147483647)
    for page in pages:
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
        # Commons metadata commonly omits the canonical URL's trailing slash.
        if isinstance(license_url, str):
            license_url = license_url.strip()
            if not license_url.endswith('/'):
                license_url += '/'
        author = plain(meta('Artist'))
        thumb = normalize_api_thumbnail(info.get('thumburl'))
        source = 'https://commons.wikimedia.org/wiki/' + quote(title.replace(' ', '_'), safe='/:_()-')
        if not isinstance(license_url, str) or not LICENSE_PATTERN.fullmatch(license_url): continue
        if not good_source(source) or len(source) > 1200 or source in seen or not thumb: continue
        if '/licenses/' in license_url and not author: continue
        seen.add(source)
        results.append({'title': title[:120], 'url': source, 'thumbnail': thumb,
                        'author': author or 'Not specified', 'license_url': license_url.replace('http://', 'https://', 1),
                        'license_name': ('CC0' if '/publicdomain/zero/' in license_url else 'CC ' + ('BY-SA' if '/by-sa/' in license_url else 'BY') + ' ' + license_url.rstrip('/').split('/')[-1])})
    continuation = data.get('continue', {})
    next_offset = continuation.get('gsroffset') if isinstance(continuation, dict) else None
    if type(next_offset) is not int or next_offset <= offset or next_offset > 2147483647:
        next_offset = None
    return {'results': results, 'next': next_offset}


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


def valid_thumbnail(url):
    """Fixed Wikimedia hosts and small imageinfo thumbnail sizes only."""
    try:
        if not isinstance(url, str) or len(url) > 1200: return False
        p = urlsplit(url)
        if (p.scheme != 'https' or p.hostname not in ('upload.wikimedia.org', 'thumb.wikimedia.org')
                or p.username or p.password or p.port is not None or p.query or p.fragment): return False
        # Reject encoded path separators and traversal, even on a trusted host.
        if re.search(r'%2f|%5c|%00|%2e|\\', p.path, re.I): return False
        return bool(re.fullmatch(r'/wikipedia/commons/thumb/[0-9a-f]/[0-9a-f]{2}/[^/]+/(?:20|40|60|120|240|250)px-[^/]+', p.path, re.I))
    except (TypeError, ValueError):
        return False


def normalize_api_thumbnail(url):
    """Strip only MediaWiki's known tracking parameters, preserving its returned host/path/size."""
    try:
        if not isinstance(url, str) or len(url) > 1600: return None
        p = urlsplit(url)
        if p.fragment: return None
        if p.query:
            params = parse_qs(p.query, strict_parsing=True, max_num_fields=3, keep_blank_values=True)
            allowed = {'utm_source': ['commons.wikimedia.org'], 'utm_campaign': ['imageinfo'], 'utm_content': ['thumbnail']}
            if params != allowed: return None
        canonical = urlunsplit((p.scheme, p.netloc, p.path, '', ''))
        return canonical if valid_thumbnail(canonical) else None
    except (ValueError, TypeError):
        return None


def analyze_reference_image(url):
    # Only bounded thumbnail URLs on Wikimedia's fixed upload host are accepted.
    if not valid_thumbnail(url):
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
    if not valid_thumbnail(url):
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
    if not good_thumb(request.full_url) and not valid_thumbnail(request.full_url):
        raise ValueError('untrusted image URL')
    with build_opener(NoRedirects()).open(request, timeout=timeout) as response:
        if response.headers.get_content_type() not in ('image/jpeg', 'image/png'):
            raise ValueError('unsupported content type')
        body = response.read(1_000_001)
        if len(body) > 1_000_000:
            raise ValueError('image too large')
        return body


def fetch_cloud_3d(prompt):
    """Anonymous Shap-E Gradio queue, fixed upstream. No returned URL is trusted blindly."""
    opener = build_opener(NoRedirects())
    headers = {'User-Agent': USER_AGENT, 'Content-Type': 'application/json'}
    body = json.dumps({'prompt': prompt, 'seed': 0, 'guidance_scale': 15, 'num_inference_steps': 64}).encode('utf-8')
    request = Request(CLOUD_3D_URL + '/gradio_api/call/v2/text-to-3d', data=body, headers=headers, method='POST')
    with opener.open(request, timeout=35) as response:
        data = json.loads(response.read(16_385))
    event_id = data.get('event_id') if isinstance(data, dict) else None
    if not isinstance(event_id, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', event_id):
        raise ValueError('invalid cloud event')
    request = Request(CLOUD_3D_URL + '/gradio_api/call/text-to-3d/' + event_id, headers={'User-Agent': USER_AGENT})
    deadline, total, event, result = time.monotonic() + 600, 0, '', None
    with opener.open(request, timeout=120) as response:
        while time.monotonic() < deadline:
            line = response.readline(65537)
            total += len(line)
            if not line or len(line) > 65536 or total > 1_000_000: break
            if line.startswith(b'event:'):
                event = line[6:].strip().decode('ascii', 'replace')
            elif line.startswith(b'data:') and event == 'complete':
                result = json.loads(line[5:].strip())
                break
            elif line.startswith(b'data:') and event == 'error':
                raise ValueError('cloud generation failed')
    item = result[0] if isinstance(result, list) and result else None
    url = item.get('url') if isinstance(item, dict) else None
    if not isinstance(url, str) or not re.fullmatch(r'https://hysts-shap-e\.hf\.space/gradio_api/file=/tmp/gradio/[A-Za-z0-9_./-]+\.glb', url) or '..' in url.split('/'):
        raise ValueError('invalid cloud model URL')
    with opener.open(Request(url, headers={'User-Agent': USER_AGENT}), timeout=120) as response:
        data = response.read(MAX_CLOUD_3D + 1)
    if len(data) < 24 or len(data) > MAX_CLOUD_3D or data[:4] != b'glTF':
        raise ValueError('invalid or oversized cloud model')
    return data


def search_free_models(query):
    """Search on demand; return only self-contained, static, small CC0 models."""
    params = urlencode({'q': query, 'limit': 60})
    data = get_json(Request(ASSET_SEARCH_URL + '?' + params, headers={'User-Agent': USER_AGENT}), timeout=25)
    if not isinstance(data, dict) or not isinstance(data.get('data'), list): raise ValueError('invalid asset catalogue')
    results = []
    for item in data['data'][:60]:
        if not isinstance(item, dict) or item.get('status') != 'published': continue
        ident, slug, title, url = item.get('id'), item.get('slug'), item.get('title'), item.get('cdnUrl')
        stats, license = item.get('stats'), item.get('license')
        if not isinstance(ident,str) or not re.fullmatch(r'[0-9]{1,12}',ident): continue
        if not isinstance(slug,str) or not re.fullmatch(r'[a-z0-9-]{1,160}',slug): continue
        if not isinstance(title,str) or not title.strip(): continue
        if not isinstance(url,str): continue
        match = re.fullmatch(r'https://cdn\.3dassets\.dev/assets/([0-9]{1,12})/v([0-9]{1,5})/model\.glb',url)
        if not match or match.group(1) != ident: continue
        if not isinstance(license,dict) or license.get('slug') != 'cc0-1.0': continue
        if not isinstance(stats,dict) or type(stats.get('fileSize')) is not int or not 24 <= stats['fileSize'] <= MAX_LIBRARY_MODEL: continue
        if type(stats.get('triangles')) is not int or not 1 <= stats['triangles'] <= 10000: continue
        if type(stats.get('vertices')) is not int or not 3 <= stats['vertices'] <= 50000: continue
        if type(stats.get('meshes')) is not int or not 1 <= stats['meshes'] <= 100: continue
        if stats.get('textures') != 0 or stats.get('animations') != []: continue
        extensions = stats.get('extensionsUsed')
        if not isinstance(extensions,list) or any(x not in ('KHR_mesh_quantization','KHR_materials_unlit') for x in extensions): continue
        results.append({'id':ident, 'version':match.group(2), 'slug':slug, 'title':title.strip()[:120], 'triangles':stats['triangles']})
        if len(results) == 12: break
    return {'results': results}


GOBKIT_URL = 'https://gobkit.com/api/free'


def gobkit_models():
    data = get_json(Request(GOBKIT_URL, headers={'User-Agent': USER_AGENT}), timeout=15)
    if not isinstance(data, dict) or not isinstance(data.get('packs'), list):
        raise ValueError('invalid Gobkit catalogue')
    models = []
    for pack in data['packs']:
        if not isinstance(pack, dict) or pack.get('id') != 'gobkit-nature-kit' or pack.get('rigged') is not False or not str(pack.get('license', '')).startswith('CC0 1.0') or not isinstance(pack.get('models'), list): continue
        for item in pack['models'][:100]:
            if not isinstance(item, dict): continue
            ident, name, url = item.get('id'), item.get('name'), item.get('url')
            if not isinstance(ident, str) or not re.fullmatch(r'[A-Za-z0-9]{1,80}', ident): continue
            if not isinstance(name, str) or not name.strip() or not isinstance(url, str): continue
            if not re.fullmatch(r'https://gobkit\.com/freebies/environment/[A-Za-z0-9_-]{1,100}\.glb', url): continue
            if item.get('rigged') is not False or item.get('animations') != [] or item.get('lowPoly') is not True or item.get('format') != 'glb' or not str(item.get('license', '')).startswith('CC0 1.0'): continue
            models.append((ident, name.strip()[:120], url))
    return models


def search_gobkit_models(query):
    # Require a matching word, never return unrelated models just to fill a scene.
    words = re.findall(r'[a-z]+', query.lower())
    results = []
    for ident, name, _ in gobkit_models():
        text = (ident + ' ' + name).lower()
        if not any(len(w) >= 3 and (w in text or (w.endswith('s') and w[:-1] in text)) for w in words): continue
        results.append({'source': 'gobkit', 'id': ident, 'version': '1', 'slug': 'nature-kit', 'title': name, 'triangles': None})
        if len(results) == 12: break
    return results


def search_all_models(query):
    # Each independent upstream failure is reported, not mistaken for an empty search.
    with ThreadPoolExecutor(max_workers=2) as pool:
        jobs = [pool.submit(search_free_models, query), pool.submit(search_gobkit_models, query)]
        results, warnings = [], []
        for name, job in zip(('3DAssets.dev', 'Gobkit'), jobs):
            try:
                value = job.result()
                if name == '3DAssets.dev':
                    value = [dict(item, source='3dassets') for item in value['results']]
                results.append(value)
            except (ValueError, URLError, OSError, TimeoutError, KeyError, TypeError):
                results.append([]); warnings.append(name)
    if len(warnings) == 2: raise ValueError('all asset sources failed')
    # Interleave providers, so a single provider cannot hide all alternatives.
    merged = []
    for i in range(12):
        for items in results:
            if i < len(items): merged.append(items[i])
            if len(merged) == 12: return {'results': merged, 'warnings': warnings}
    return {'results': merged, 'warnings': warnings}


def download_gobkit_model(ident, version):
    if not isinstance(ident, str) or not re.fullmatch(r'[A-Za-z0-9]{1,80}', ident) or version != '1': raise ValueError('invalid Gobkit identifier')
    matches = [url for item_id, _, url in gobkit_models() if item_id == ident]
    if len(matches) != 1: raise ValueError('unknown Gobkit model')
    with build_opener(NoRedirects()).open(Request(matches[0], headers={'User-Agent': USER_AGENT}), timeout=30) as response:
        model = response.read(MAX_LIBRARY_MODEL + 1)
    if len(model) < 24 or len(model) > MAX_LIBRARY_MODEL or model[:4] != b'glTF': raise ValueError('invalid model')
    return model


def download_free_model(ident, version):
    if not isinstance(ident,str) or not re.fullmatch(r'[0-9]{1,12}',ident) or not isinstance(version,str) or not re.fullmatch(r'[0-9]{1,5}',version):
        raise ValueError('invalid asset identifier')
    url = ASSET_CDN_URL + '/assets/' + ident + '/v' + version + '/model.glb'
    with build_opener(NoRedirects()).open(Request(url,headers={'User-Agent': USER_AGENT}),timeout=120) as response:
        model = response.read(MAX_LIBRARY_MODEL + 1)
    if len(model) < 24 or len(model) > MAX_LIBRARY_MODEL or model[:4] != b'glTF': raise ValueError('invalid model')
    return model


# ── Optional free local language model ────────────────────────────────────────
# The world planner is fully deterministic and works offline without this. When
# the operator starts the server with --llm-url pointing at a model runtime on
# the same device (Ollama's /api/generate, or any OpenAI-compatible
# /v1/chat/completions such as the llama.cpp server), the planner may ask it to
# fill gaps only. The URL must be loopback HTTP, so this proxy can never reach a
# paid cloud service, and every answer is re-validated by the app.
LLM_URL = ''
LLM_TIMEOUT = 45
LLM_LOCK = threading.Lock()
LLM_MAX_PROMPT = 4000

LLM_ENUMS = {
    'language': ('ar', 'en', 'mixed'),
    'biome': ('meadow', 'forest', 'mountains', 'desert', 'island', 'ruins'),
    'landform': ('flat', 'hills', 'mountains', 'dunes', 'islands', 'valley', 'plateau', 'canyon', 'volcano', 'crater'),
    'timeOfDay': ('day', 'sunset', 'night'),
    'scale': ('small', 'medium', 'large'),
    'density': ('sparse', 'normal', 'dense'),
    'style': ('cartoon', 'natural', 'stylized'),
}
LLM_SELECTORS = ('north', 'south', 'east', 'west', 'center', 'edge', 'summit', 'base', 'slope', 'waterfront')
LLM_HEX_COLOR = re.compile(r'^#[0-9a-fA-F]{6}$')


def llm_configured(url=None):
    """True only for a loopback HTTP URL, so no cloud endpoint can be proxied."""
    target = LLM_URL if url is None else url
    if not target:
        return False
    parts = urlsplit(target)
    return parts.scheme == 'http' and parts.hostname in ('127.0.0.1', 'localhost', '::1')


def llm_flavour(url):
    return 'ollama' if url.rstrip('/').endswith('/api/generate') else 'openai'


def llm_base(url):
    parts = urlsplit(url)
    path = parts.path
    for suffix in ('/api/generate', '/v1/chat/completions', '/chat/completions', '/completion'):
        if path.rstrip('/').endswith(suffix):
            path = path[:len(path) - len(suffix)]
            break
    return urlunsplit((parts.scheme, parts.netloc, path.rstrip('/'), '', ''))


def llm_call(url, payload=None, timeout=None):
    """One loopback JSON call: no redirects, capped body, no retries."""
    opener = build_opener(NoRedirects())
    if payload is None:
        request = Request(url, headers={'User-Agent': USER_AGENT})
    else:
        request = Request(url, data=json.dumps(payload).encode('utf-8'),
                          headers={'User-Agent': USER_AGENT, 'Content-Type': 'application/json'}, method='POST')
    with opener.open(request, timeout=timeout or LLM_TIMEOUT) as response:
        body = response.read(MAX_RESPONSE + 1)
        if len(body) > MAX_RESPONSE:
            raise ValueError('response too large')
        return json.loads(body)


def llm_names(entries, key):
    if not isinstance(entries, list):
        return []
    return [entry[key] for entry in entries if isinstance(entry, dict) and isinstance(entry.get(key), str) and entry[key].strip()]


def llm_models():
    """Model ids the local runtime offers; empty means the tier is unavailable."""
    base = llm_base(LLM_URL)
    if llm_flavour(LLM_URL) == 'ollama':
        data = llm_call(base + '/api/tags')
        return llm_names(data.get('models') if isinstance(data, dict) else None, 'name')
    data = llm_call(base + '/v1/models')
    return llm_names(data.get('data') if isinstance(data, dict) else None, 'id')


def llm_model_ok(model, available):
    if not model:
        return False
    if not available:
        return True
    return any(name == model or name.split(':')[0] == model.split(':')[0] for name in available)


def llm_complete(prompt, model):
    if llm_flavour(LLM_URL) == 'ollama':
        data = llm_call(LLM_URL, {'model': model, 'prompt': prompt, 'stream': False,
                                  'format': 'json', 'options': {'temperature': 0}})
        text = data.get('response') if isinstance(data, dict) else None
    else:
        data = llm_call(LLM_URL, {'model': model, 'temperature': 0, 'stream': False,
                                  'messages': [{'role': 'user', 'content': prompt}]})
        choices = data.get('choices') if isinstance(data, dict) else None
        first = choices[0] if isinstance(choices, list) and choices else None
        message = first.get('message') if isinstance(first, dict) else None
        text = message.get('content') if isinstance(message, dict) else None
    if not isinstance(text, str) or not text.strip():
        raise ValueError('model returned no text')
    return text[:64_000]


def llm_prompt(description, language, known_terms, gaps):
    """Asks only about the gaps, and only in the planner's own vocabulary."""
    return (
        'You fill gaps in a structured world specification for an offline 3D world builder. '
        f'Description language: {language}. Fields still missing: {", ".join(gaps) or "none"}. '
        f'Vocabulary ids you may use: {", ".join(known_terms) or "none"}.\n'
        'Reply with ONE JSON object and nothing else. Include a key only when the description '
        'implies it; omit anything uncertain. Allowed keys and values:\n'
        '{"biome":"meadow|forest|mountains|desert|island|ruins",'
        '"landform":"flat|hills|mountains|dunes|islands|valley|plateau|canyon|volcano|crater",'
        '"timeOfDay":"day|sunset|night","scale":"small|medium|large",'
        '"density":"sparse|normal|dense","style":"cartoon|natural|stylized",'
        '"weather":["rain"|"snow"|"fog"|"storm"],"architecture":["medieval"|"modern"|...],'
        '"materials":{"wall":"#rrggbb","roof":"#rrggbb"},'
        '"regions":[{"name":"short name","selector":"north|south|east|west|center|edge|summit|base|slope|waterfront"}],'
        '"animals":[{"id":"known id","count":1}],"clarifications":["one short question"],"name":"short world name"}\n'
        'Never invent counts of trees, rocks or buildings, never place objects, and never use a '
        'term outside the vocabulary above.\n'
        f'Description: {description}'
    )


def llm_extract_json(text):
    cleaned = text.strip()
    if cleaned.startswith('```'):
        cleaned = re.sub(r'^```[a-zA-Z]*\s*|\s*```$', '', cleaned).strip()
    start, end = cleaned.find('{'), cleaned.rfind('}')
    if start < 0 or end <= start:
        raise ValueError('no JSON object in model output')
    value = json.loads(cleaned[start:end + 1])
    if not isinstance(value, dict):
        raise ValueError('model output is not an object')
    return value


def llm_short_list(value, limit, size):
    if not isinstance(value, list):
        return []
    return [item.strip()[:size] for item in value[:limit] if isinstance(item, str) and item.strip()]


def llm_sanitize(value):
    """Keeps only fields the app's strict schema also accepts."""
    out = {}
    for key, allowed in LLM_ENUMS.items():
        item = value.get(key)
        if isinstance(item, str) and item.strip().lower() in allowed:
            out[key] = item.strip().lower()
    for key in ('weather', 'architecture'):
        items = llm_short_list(value.get(key), 6, 24)
        if items:
            out[key] = items
    materials = value.get('materials')
    if isinstance(materials, dict):
        clean = {side: materials[side].strip() for side in ('wall', 'roof')
                 if isinstance(materials.get(side), str) and LLM_HEX_COLOR.match(materials[side].strip())}
        palette = materials.get('palette')
        if isinstance(palette, str) and palette.strip():
            clean['palette'] = palette.strip()[:24]
        if clean:
            out['materials'] = clean
    regions = value.get('regions')
    if isinstance(regions, list):
        clean = []
        for region in regions[:8]:
            if not isinstance(region, dict):
                continue
            name, selector = region.get('name'), region.get('selector')
            if not (isinstance(name, str) and name.strip()):
                continue
            if not (isinstance(selector, str) and selector.strip().lower() in LLM_SELECTORS):
                continue
            entry = {'name': name.strip()[:40], 'selector': selector.strip().lower()}
            biome = region.get('biome')
            if isinstance(biome, str) and biome.strip().lower() in LLM_ENUMS['biome']:
                entry['biome'] = biome.strip().lower()
            clean.append(entry)
        if clean:
            out['regions'] = clean
    animals = value.get('animals')
    if isinstance(animals, list):
        clean = []
        for animal in animals[:12]:
            if not isinstance(animal, dict):
                continue
            ident, count = animal.get('id'), animal.get('count')
            if isinstance(ident, str) and ident.strip() and type(count) is int and 1 <= count <= 200:
                clean.append({'id': ident.strip()[:24], 'count': count})
        if clean:
            out['animals'] = clean
    questions = llm_short_list(value.get('clarifications'), 4, 200)
    if questions:
        out['clarifications'] = questions
    for key, size in (('name', 80), ('summary', 400)):
        item = value.get(key)
        if isinstance(item, str) and item.strip():
            out[key] = item.strip()[:size]
    return out


def llm_enrich(payload):
    """One guarded completion; returns (enrichment, model) or raises."""
    description, language = payload.get('prompt'), payload.get('language')
    if not isinstance(description, str) or not description.strip() or len(description) > LLM_MAX_PROMPT:
        raise ValueError('invalid prompt')
    if not isinstance(language, str) or language not in LLM_ENUMS['language']:
        raise ValueError('invalid language')
    known_terms = llm_short_list(payload.get('knownTerms'), 200, 24)
    gaps = llm_short_list(payload.get('gaps'), 20, 24)
    if not LLM_LOCK.acquire(blocking=False):
        raise ValueError('busy')
    try:
        available = llm_models()
        model = payload.get('model')
        model = model.strip() if isinstance(model, str) and model.strip() else (available[0] if available else '')
        if not llm_model_ok(model, available):
            raise ValueError('unknown local model')
        text = llm_complete(llm_prompt(description.strip(), language, known_terms, gaps), model)
        return llm_sanitize(llm_extract_json(text)), model
    finally:
        LLM_LOCK.release()


VISION_FILES = frozenset({
    '/vision-worker.js', '/vision/scene.onnx', '/vision/ort.wasm.min.js',
    '/vision/ort-wasm-simd-threaded.mjs', '/vision/ort-wasm-simd-threaded.wasm',
})
STATIC_FILES = VISION_FILES | {'/world-builder-mobile.html'}


class Handler(SimpleHTTPRequestHandler):
    # Android Python installations can have an incomplete MIME database.
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript',
                      '.mjs': 'text/javascript', '.wasm': 'application/wasm',
                      '.onnx': 'application/octet-stream'}
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
        if not self.valid_host():
            self.send_error(404)
            return
        try:
            parsed = urlsplit(self.path)
        except ValueError:
            self.send_error(400)
            return
        if parsed.path == '/api/image-thumbnail':
            # Images are same-origin in the browser. Reject explicit cross-site use;
            # older browsers may omit these headers for ordinary image requests.
            origin = self.headers.get('Origin')
            if (origin and origin != f"http://{self.headers.get('Host', '')}") or self.headers.get('Sec-Fetch-Site') == 'cross-site':
                self.api_result(403, {'error': 'invalid origin'})
                return
            try:
                if len(parsed.query) > 4096: raise ValueError('query too long')
                params = parse_qs(parsed.query, strict_parsing=True, max_num_fields=1)
                urls = params.get('url', [])
                if set(params) != {'url'} or len(urls) != 1 or not valid_thumbnail(urls[0]): raise ValueError('invalid thumbnail')
                raw = get_image(Request(urls[0], headers={'User-Agent': USER_AGENT}), timeout=25)
                if len(raw) > 1_000_000: raise ValueError('image too large')
                if raw.startswith(b'\x89PNG\r\n\x1a\n'):
                    mime = 'image/png'
                elif raw.startswith(b'\xff\xd8\xff'):
                    mime = 'image/jpeg'
                else:
                    raise ValueError('invalid image format')
            except ValueError:
                self.api_result(400, {'error': 'invalid thumbnail'})
                return
            except (HTTPError, URLError, TimeoutError, OSError):
                self.api_result(502, {'error': 'thumbnail unavailable'})
                return
            self.send_response(200)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(raw)))
            self.send_header('Cache-Control', 'private, max-age=3600')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(raw)
            return
        if self.path not in STATIC_FILES:
            self.send_error(404)
            return
        super().do_GET()

    def do_HEAD(self):
        if not self.valid_host() or self.path not in STATIC_FILES:
            self.send_error(404)
            return
        super().do_HEAD()

    def do_POST(self):
        host = self.headers.get('Host', '')
        if not self.valid_host() or self.headers.get('Origin', '') != f'http://{host}':
            self.api_result(403, {'error': 'invalid origin'})
            return
        if self.path not in ('/api/online', '/api/search', '/api/image-search', '/api/image-analyze', '/api/image-pixels', '/api/translate-en', '/api/wiki-article', '/api/dictionary', '/api/knowledge', '/api/house-learning', '/api/text-to-3d', '/api/asset-library/search', '/api/asset-library/model', '/api/local-llm'):
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
            if self.path == '/api/local-llm':
                if not llm_configured():
                    self.api_result(404, {'error': 'llm disabled'})
                    return
                if not set(payload) <= {'probe', 'prompt', 'language', 'knownTerms', 'gaps', 'model'}:
                    self.api_result(400, {'error': 'invalid request'})
                    return
                try:
                    if payload.get('probe') is True:
                        models = llm_models()
                        if not models:
                            self.api_result(200, {'ok': False, 'error': 'no local model'})
                            return
                        self.api_result(200, {'ok': True, 'models': models[:40]})
                        return
                    enrichment, model = llm_enrich(payload)
                    self.api_result(200, {'ok': True, 'model': model, 'enrichment': enrichment})
                except (HTTPError, URLError, TimeoutError, OSError, ValueError, UnicodeError):
                    # The planner stays on its deterministic tier; this is not an error for it.
                    self.api_result(200, {'ok': False, 'error': 'llm unavailable'})
                return
            if self.path == '/api/asset-library/search':
                query = payload.get('query')
                if set(payload) != {'query'} or not isinstance(query,str) or not query.strip() or len(query) > 200:
                    self.api_result(400, {'error': 'invalid query'})
                    return
                self.api_result(200, search_all_models(query.strip()))
                return
            if self.path == '/api/asset-library/model':
                if set(payload) not in ({'id','version'}, {'id','version','source'}):
                    self.api_result(400, {'error': 'invalid asset'})
                    return
                try:
                    source = payload.get('source', '3dassets')
                    if source == '3dassets': model = download_free_model(payload.get('id'), payload.get('version'))
                    elif source == 'gobkit': model = download_gobkit_model(payload.get('id'), payload.get('version'))
                    else: raise ValueError('invalid source')
                except ValueError:
                    self.api_result(400, {'error': 'invalid asset'})
                    return
                self.send_response(200)
                self.send_header('Content-Type', 'model/gltf-binary')
                self.send_header('Content-Length', str(len(model)))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('X-World-Builder-Proxy', '1')
                self.end_headers()
                self.wfile.write(model)
                return
            if self.path == '/api/text-to-3d':
                query = payload.get('query')
                if set(payload) != {'query'} or not isinstance(query, str) or not query.strip() or len(query) > 400:
                    self.api_result(400, {'error': 'invalid prompt'})
                    return
                if not CLOUD_3D_LOCK.acquire(blocking=False):
                    self.api_result(429, {'error': 'busy'})
                    return
                try:
                    model = fetch_cloud_3d(query.strip())
                finally:
                    CLOUD_3D_LOCK.release()
                self.send_response(200)
                self.send_header('Content-Type', 'model/gltf-binary')
                self.send_header('Content-Length', str(len(model)))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('X-World-Builder-Proxy', '1')
                self.end_headers()
                self.wfile.write(model)
                return
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
                if not valid_thumbnail(payload.get('url')):
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
            if self.path == '/api/wiki-article':
                language = 'ar' if re.search(r'[\u0600-\u06ff]', query) else 'en'
                hostname = f'{language}.wikipedia.org'
                params = urlencode({'action': 'query', 'format': 'json', 'formatversion': 2, 'prop': 'extracts',
                                    'titles': query.strip(), 'exintro': 1, 'explaintext': 1, 'exchars': 1200, 'redirects': 1})
                data = get_json(Request(f'https://{hostname}/w/api.php?' + params, headers={'User-Agent': USER_AGENT}), timeout=25)
                if not isinstance(data, dict) or 'error' in data or not isinstance(data.get('query', {}).get('pages'), list):
                    raise ValueError('invalid article response')
                pages = data['query']['pages']
                if not pages or not isinstance(pages[0], dict) or pages[0].get('missing'):
                    self.api_result(200, {'article': None})
                    return
                title, extract = pages[0].get('title'), pages[0].get('extract')
                if not isinstance(title, str) or not title or not isinstance(extract, str):
                    raise ValueError('invalid article extract')
                self.api_result(200, {'article': {'title': title[:120], 'url': f'https://{hostname}/wiki/{quote(title.replace(" ", "_"), safe="/_():-")}', 'content': extract[:1200]}})
                return
            if self.path == '/api/translate-en':
                # Fixed host and API parameters; a title is data, not a URL.
                params = urlencode({'action': 'query', 'format': 'json', 'formatversion': 2,
                                    'prop': 'langlinks', 'titles': query.strip(), 'lllang': 'en', 'lllimit': 1})
                data = get_json(Request('https://ar.wikipedia.org/w/api.php?' + params, headers={'User-Agent': USER_AGENT}), timeout=25)
                if not isinstance(data, dict) or 'error' in data or not isinstance(data.get('query', {}).get('pages'), list):
                    raise ValueError('invalid language links response')
                pages = data['query']['pages']
                title = None
                if isinstance(pages, list) and pages and isinstance(pages[0], dict):
                    links = pages[0].get('langlinks', [])
                    if isinstance(links, list):
                        title = next((link.get('title') for link in links if isinstance(link, dict) and link.get('lang') == 'en' and isinstance(link.get('title'), str)), None)
                self.api_result(200, {'title': title[:120] if title else None})
                return
            if self.path == '/api/dictionary':
                word = query.strip()
                if not re.fullmatch(r'[^\W\d_]{2,80}', word, re.UNICODE):
                    self.api_result(400, {'error': 'single word required'})
                    return
                self.api_result(200, dictionary_definitions(word))
                return
            # Numeric offsets only; never accept arbitrary URLs or API parameters.
            offset = payload.get('offset', 0)
            if type(offset) is not int or not 0 <= offset <= 2147483647:
                self.api_result(400, {'error': 'invalid offset'})
                return
            if self.path == '/api/image-search':
                self.api_result(200, search_image_references(query.strip(), offset))
                return
            language = 'ar' if re.search(r'[\u0600-\u06ff]', query) else 'en'
            hostname = f'{language}.wikipedia.org'
            params = {'action': 'query', 'format': 'json', 'formatversion': 2,
                      'list': 'search', 'srnamespace': 0, 'srlimit': 20, 'srprop': 'snippet', 'srsearch': query}
            if offset:
                params.update({'sroffset': offset, 'continue': '-||'})
            target = f'https://{hostname}/w/api.php?' + urlencode(params)
            response = get_json(Request(target, headers={'User-Agent': USER_AGENT}), timeout=25)
            if not isinstance(response, dict) or 'error' in response or not isinstance(response.get('query', {}).get('search'), list):
                raise ValueError('invalid search response')
            results = []
            for page in response['query']['search'][:20]:
                if not isinstance(page, dict): continue
                title = page.get('title')
                if not isinstance(title, str) or not title: continue
                excerpt = page.get('snippet') or ''
                if not isinstance(excerpt, str): excerpt = ''
                key = title.replace(' ', '_')
                results.append({'title': title[:120], 'url': f'https://{hostname}/wiki/{quote(key, safe="/_():-")}',
                                'content': strip_html(excerpt)})
            continuation = response.get('continue', {})
            next_offset = continuation.get('sroffset') if isinstance(continuation, dict) else None
            if type(next_offset) is not int or next_offset <= offset or next_offset > 2147483647:
                next_offset = None
            self.api_result(200, {'results': results, 'next': next_offset})
        except (HTTPError, URLError, TimeoutError, OSError, ValueError, UnicodeError):
            self.api_result(502, {'error': 'service unavailable'})


def main():
    parser = argparse.ArgumentParser(description='World Builder local phone server')
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--directory', default=os.path.dirname(os.path.abspath(__file__)))
    parser.add_argument('--llm-url', default='',
                        help='loopback URL of a free local model runtime (Ollama /api/generate or an '
                             'OpenAI-compatible /v1/chat/completions); empty keeps the planner on rules only')
    parser.add_argument('--llm-timeout', type=int, default=45, help='seconds to wait for the local model')
    args = parser.parse_args()
    global LLM_URL, LLM_TIMEOUT
    LLM_URL = args.llm_url.strip()
    LLM_TIMEOUT = max(5, min(300, args.llm_timeout))
    if LLM_URL and not llm_configured():
        print('رُفض --llm-url: يُسمح فقط بعنوان محلي مثل http://127.0.0.1:11434/api/generate لنموذج مجاني على جهازك.', flush=True)
        return 2
    handler = partial(Handler, directory=args.directory)
    with ThreadingHTTPServer(('127.0.0.1', args.port), handler) as server:
        server.wiki_learner = WikiLearner(args.directory, get_json, USER_AGENT)
        server.wiki_learner.start()
        server.house_learner = HouseLearner(args.directory, get_json, get_image, USER_AGENT)
        server.house_learner.start()
        print('التعلم المحدود من ويكيبيديا وصور البيوت يعمل أثناء بقاء Termux شغالاً (يتطلب الصور python-pillow).', flush=True)
        if LLM_URL:
            print(f'المخطط قد يستشير نموذجاً لغوياً محلياً مجانياً عبر {LLM_URL} عند الطلب؛ التطبيق يعمل بدونه دون اتصال.', flush=True)
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
