"""Small experimental inverse-rendering learner, not a general image-to-3D model.

Periodically searches Wikimedia Commons for freely licensed house images. A
CPU-only 64px projection of a parameterised house is compared to each image.
It stores bounded averages of the best fitting parameters and attribution, not
image files. Scores are crude pixel error, not a measure of 3D reconstruction.
"""
import hashlib
import html
import io
import json
import math
import os
import random
import re
import threading
from urllib.parse import urlencode, urlsplit, quote
from urllib.request import Request

try:
    from PIL import Image, ImageChops, ImageDraw, ImageOps, ImageStat
    Image.MAX_IMAGE_PIXELS = 1_000_000
except ImportError:
    Image = None

GROUPS = ('default', 'small', 'tall', 'wide')
LIMITS = ((0.55, 1.8), (0.55, 1.8), (0.55, 1.8), (0.7, 1.3))
LICENSE_PATTERN = re.compile(r'^https?://creativecommons\.org/(?:licenses/(?:by|by-sa)/[1-4]\.0/|publicdomain/zero/1\.0/)$')
MAX_SOURCES = 100
SEARCHES = ('cartoon house', 'illustration cottage house', 'small house illustration', 'house drawing')


def plain(value):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]*>', ' ', value if isinstance(value, str) else ''))).strip()[:200]


def group_for_text(text):
    text = text.lower()
    if re.search(r'\b(?:tall|towering)\b|طويل', text): return 'tall'
    if re.search(r'\b(?:wide|broad)\b|عريض', text): return 'wide'
    if re.search(r'\b(?:small|tiny|little)\b|صغير', text): return 'small'
    return 'default'


def good_thumb(url):
    try:
        p = urlsplit(url)
        return p.scheme == 'https' and p.hostname == 'upload.wikimedia.org' and not p.username and not p.password and p.port in (None, 443) and p.path.startswith('/wikipedia/commons/') and not p.query and not p.fragment
    except (ValueError, TypeError):
        return False


def good_source(url):
    try:
        p = urlsplit(url)
        return p.scheme == 'https' and p.hostname == 'commons.wikimedia.org' and not p.username and not p.password and p.port in (None, 443) and p.path.startswith('/wiki/File:') and not p.query and not p.fragment
    except (ValueError, TypeError):
        return False


def default_state():
    return {'version': 1, 'cursor': 0, 'samples': 0,
            'profiles': {group: {'count': 0, 'mean': [1.0, 1.0, 1.0, 1.0]} for group in GROUPS},
            'sources': [], 'last_loss': None}


def valid_state(state):
    try:
        if state['version'] != 1 or type(state['cursor']) is not int or not 0 <= state['cursor'] < 80:
            return False
        if type(state['samples']) is not int or not 0 <= state['samples'] <= MAX_SOURCES:
            return False
        if set(state['profiles']) != set(GROUPS) or len(state['sources']) > MAX_SOURCES:
            return False
        for profile in state['profiles'].values():
            if type(profile['count']) is not int or not 0 <= profile['count'] <= state['samples'] or len(profile['mean']) != 4:
                return False
            if any(not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or not lo <= value <= hi for value, (lo, hi) in zip(profile['mean'], LIMITS)):
                return False
        if sum(v['count'] for v in state['profiles'].values()) != state['samples'] or state['samples'] != len(state['sources']):
            return False
        if state['last_loss'] is not None and (not isinstance(state['last_loss'], (int, float)) or not 0 <= state['last_loss'] <= 255):
            return False
        seen = set()
        for source in state['sources']:
            if not good_source(source['url']) or len(source['url']) > 1200 or source['url'] in seen or not LICENSE_PATTERN.fullmatch(source['license_url']): return False
            if not isinstance(source['title'], str) or len(source['title']) > 120 or not isinstance(source['author'], str) or len(source['author']) > 200: return False
            if source['group'] not in GROUPS or len(source['params']) != 4 or any(not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) or not lo <= v <= hi for v, (lo, hi) in zip(source['params'], LIMITS)): return False
            seen.add(source['url'])
        return True
    except (TypeError, KeyError, ValueError):
        return False


def render_house(params, background=(200, 200, 200), wall=(190, 176, 145), roof=(165, 90, 55)):
    """Draw a simple 3D box and pyramidal roof from one fixed viewpoint."""
    if Image is None: raise RuntimeError('Pillow is required')
    sx, sy, sz, detail = params
    w, d, h, rh = 3.4 * sx, 3.0 * sz, 2.6 * sy, 1.55 * sy
    def pt(x, y, z):
        return (32 + (0.83 * x - 0.55 * z) * 6.3, 50 + (0.22 * x + 0.33 * z - 0.86 * y) * 6.3)
    def color(rgb, factor): return tuple(max(0, min(255, int(x * factor))) for x in rgb)
    image = Image.new('RGB', (64, 64), background)
    draw = ImageDraw.Draw(image)
    x, z = w / 2, d / 2
    front = [(-x, 0, z), (x, 0, z), (x, h, z), (-x, h, z)]
    side = [(x, 0, z), (x, 0, -z), (x, h, -z), (x, h, z)]
    apex = (0, h + rh, 0)
    roof_front = [(-x * 1.08, h, z * 1.12), (x * 1.08, h, z * 1.12), apex]
    roof_side = [(x * 1.08, h, z * 1.12), (x * 1.08, h, -z * 1.12), apex]
    for face, tint in ((side, color(wall, .78)), (front, wall), (roof_side, color(roof, .76)), (roof_front, roof)):
        draw.polygon([pt(*p) for p in face], fill=tint)
    door = [(-w*.10,0,z+.02), (w*.10,0,z+.02), (w*.10,h*.5,z+.02), (-w*.10,h*.5,z+.02)]
    draw.polygon([pt(*p) for p in door], fill=(65, 45, 32))
    for cx in (-w*.27, w*.27):
        frame = [pt(cx-w*.09,h*.48,z+.03), pt(cx+w*.09,h*.48,z+.03), pt(cx+w*.09,h*.76,z+.03), pt(cx-w*.09,h*.76,z+.03)]
        draw.polygon(frame, fill=(65, 45, 32))
        inset = min(.08 * detail, w*.04)
        glass = [pt(cx-w*.09+inset,h*.48+inset,z+.04), pt(cx+w*.09-inset,h*.48+inset,z+.04), pt(cx+w*.09-inset,h*.76-inset,z+.04), pt(cx-w*.09+inset,h*.76-inset,z+.04)]
        draw.polygon(glass, fill=(100, 159, 176))
    return image


def image_loss(target, rendered):
    # Pixel error at very low resolution; it is not geometric truth or an accuracy percentage.
    return sum(ImageStat.Stat(ImageChops.difference(target, rendered)).mean) / 3


def fit_house(target, seed, steps=32):
    # Transparent PNGs should be compared against a neutral background, not
    # the arbitrary RGB values hidden under transparent pixels.
    if 'A' in target.getbands() or 'transparency' in target.info:
        rgba = target.convert('RGBA')
        base = Image.new('RGBA', rgba.size, (240, 240, 240, 255))
        target = Image.alpha_composite(base, rgba).convert('RGB')
    else:
        target = target.convert('RGB')
    target = ImageOps.fit(target, (64, 64))
    # Estimate colours from fixed image zones; this does not segment the object.
    background = target.getpixel((0, 0))
    roof = target.getpixel((32, 20))
    wall = target.getpixel((32, 39))
    rng = random.Random(seed)
    best = [1., 1., 1., 1.]
    base = image_loss(target, render_house(best, background, wall, roof))
    best_loss = base
    for _ in range(steps):
        candidate = best.copy()
        axis = rng.randrange(4)
        lo, hi = LIMITS[axis]
        candidate[axis] = max(lo, min(hi, candidate[axis] + rng.uniform(-0.25, 0.25)))
        score = image_loss(target, render_house(candidate, background, wall, roof))
        if score < best_loss:
            best, best_loss = candidate, score
    return best, best_loss, base


class HouseLearner:
    def __init__(self, directory, get_json, get_binary, user_agent, interval=600):
        self.file = os.path.join(directory, 'house-image-learning.json')
        self.get_json, self.get_binary, self.user_agent = get_json, get_binary, user_agent
        self.interval = interval
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.status = 'missing_pillow' if Image is None else 'starting'
        try:
            if os.path.getsize(self.file) > 1_000_000: raise ValueError('state file too large')
            with open(self.file, encoding='utf-8') as f: data = json.load(f)
            self.state = data if valid_state(data) else default_state()
        except (OSError, ValueError, TypeError): self.state = default_state()

    def snapshot(self):
        with self.lock:
            return {**self.state, 'sources': [{k: item[k] for k in ('title', 'url', 'author', 'license_url')} for item in self.state['sources']], 'status': self.status}

    def learn_once(self):
        if Image is None:
            with self.lock: self.status = 'missing_pillow'
            return
        with self.lock:
            state = json.loads(json.dumps(self.state))
        cursor = state['cursor']
        search = SEARCHES[cursor % len(SEARCHES)]
        offset = (cursor // len(SEARCHES)) * 5
        query = urlencode({'action': 'query', 'format': 'json', 'formatversion': 2, 'generator': 'search',
                           'gsrnamespace': 6, 'gsrlimit': 5, 'gsroffset': offset, 'gsrsearch': search + ' filetype:bitmap',
                           'prop': 'imageinfo', 'iiprop': 'url|mime|extmetadata', 'iiurlwidth': 192})
        try:
            data = self.get_json(Request('https://commons.wikimedia.org/w/api.php?' + query, headers={'User-Agent': self.user_agent}), timeout=25)
            if not isinstance(data, dict) or 'error' in data: raise ValueError('Commons API error')
            pages = data.get('query', {}).get('pages', [])
            if not isinstance(pages, list): raise ValueError('invalid pages')
            known = {item['url'] for item in state['sources']}
            found = None
            for page in pages[:5]:
                if not isinstance(page, dict): continue
                title = page.get('title')
                info = page.get('imageinfo')
                if not isinstance(title, str) or not title.startswith('File:') or not isinstance(info, list) or not info or not isinstance(info[0], dict): continue
                info = info[0]
                metadata = info.get('extmetadata', {})
                if not isinstance(metadata, dict): continue
                def meta(key):
                    entry = metadata.get(key)
                    return entry.get('value', '') if isinstance(entry, dict) else ''
                license_url = meta('LicenseUrl')
                author = plain(meta('Artist'))
                thumb = info.get('thumburl')
                source = 'https://commons.wikimedia.org/wiki/' + quote(title.replace(' ', '_'), safe='/:_()-')
                if not isinstance(license_url, str) or not LICENSE_PATTERN.fullmatch(license_url) or not good_source(source) or len(source) > 1200 or source in known or not good_thumb(thumb): continue
                if '/licenses/' in license_url and not author: continue  # attribution is mandatory
                found = (title, info, source, license_url, author or 'Not specified', meta('ImageDescription'))
                break
            state['cursor'] = (cursor + 1) % 80
            accepted = False
            image_failed = False
            if found:
                title, info, source, license_url, author, description = found
                try:
                    raw = self.get_binary(Request(info['thumburl'], headers={'User-Agent': self.user_agent}), timeout=25)
                    if len(raw) > 1_000_000: raise ValueError('image too large')
                    with Image.open(io.BytesIO(raw)) as image:
                        if image.format not in ('JPEG', 'PNG') or image.width * image.height > 1_000_000:
                            raise ValueError('unsupported or large image')
                        image.load()
                        seed = int.from_bytes(hashlib.sha256(source.encode()).digest()[:8], 'big')
                        params, loss, baseline = fit_house(image, seed)
                except Exception:
                    # Skip a corrupt/unavailable thumbnail and continue with the next search later.
                    image_failed = True
                    found = None
            if found:
                group = group_for_text(title + ' ' + plain(description))
                profile = state['profiles'][group]
                if loss < baseline - 0.05:
                    if len(state['sources']) >= MAX_SOURCES:
                        old = state['sources'].pop(0)
                        old_profile = state['profiles'][old['group']]
                        n = old_profile['count']
                        old_profile['mean'] = [max(lo, min(hi, (value * n - x) / (n - 1))) for value, x, (lo, hi) in zip(old_profile['mean'], old['params'], LIMITS)] if n > 1 else [1., 1., 1., 1.]
                        old_profile['count'] -= 1
                        state['samples'] -= 1
                    count = profile['count'] + 1
                    profile['mean'] = [value + (x - value) / count for value, x in zip(profile['mean'], params)]
                    profile['count'] = count
                    state['samples'] += 1
                    state['last_loss'] = loss
                    state['sources'].append({'title': title[:120], 'url': source, 'author': author, 'license_url': license_url, 'group': group, 'params': params})
                    accepted = True
            if not valid_state(state): raise ValueError('invalid state')
            with self.lock:
                tmp = self.file + '.tmp'
                with open(tmp, 'w', encoding='utf-8') as f: json.dump(state, f, ensure_ascii=False)
                os.replace(tmp, self.file)
                self.state = state
                self.status = 'learning' if accepted else ('unavailable' if image_failed else ('no_improvement' if found else 'no_new_images'))
        except Exception:  # Network, corrupt image or storage failure must not kill the worker.
            with self.lock: self.status = 'unavailable'

    def run(self):
        while not self.stop_event.is_set():
            self.learn_once()
            self.stop_event.wait(self.interval)

    def start(self): threading.Thread(target=self.run, daemon=True, name='house-image-learner').start()
    def stop(self): self.stop_event.set()
