"""Bounded map-vocabulary learner for the Termux server.

Fetches only fixed Wikipedia topics; never executes page text. It trains a tiny
word-frequency classifier, not a neural network or image/3D generator.
"""
import json
import os
import re
import threading
from urllib.parse import urlencode, urlsplit, quote
from urllib.request import Request

TOPICS = [
    ('desert', 'desert', r'desert|dune|oasis'), ('desert', 'oasis', r'oasis|desert|dune'),
    ('desert', 'صحراء', r'صحراء|واحة|كثبان'), ('desert', 'واحة', r'واحة|صحراء'),
    ('forest', 'forest', r'forest|woodland|rainforest'), ('forest', 'rainforest', r'forest|woodland'),
    ('forest', 'غابة', r'غابة|غابات|أحراش'),
    ('mountains', 'mountain', r'mountain|alpine|peak'), ('mountains', 'canyon', r'canyon|mountain'),
    ('mountains', 'جبل', r'جبل|جبال|قمة'),
    ('island', 'island', r'island|archipelago|atoll'), ('island', 'archipelago', r'island|archipelago'),
    ('island', 'جزيرة', r'جزيرة|جزر|أرخبيل'),
]
CLASSES = ('desert', 'forest', 'mountains', 'island')
FEATURES = frozenset(('desert', 'deserts', 'arid', 'dune', 'dunes', 'oasis', 'oases', 'sand',
                      'forest', 'forests', 'woodland', 'rainforest', 'canopy', 'jungle',
                      'mountain', 'mountains', 'alpine', 'summit', 'peak', 'canyon', 'cliff',
                      'island', 'islands', 'archipelago', 'atoll', 'islet', 'coast',
                      'صحراء', 'صحراوي', 'قاحلة', 'رمال', 'كثبان', 'واحة', 'واحات',
                      'غابة', 'غابات', 'احراش', 'ادغال', 'جبل', 'جبال', 'مرتفعات',
                      'قمة', 'قمم', 'جزيرة', 'جزر', 'ارخبيل', 'سواحل'))
MAX_SOURCES = 200


def terms(text):
    text = re.sub(r'[\u064b-\u065f\u0670]', '', text.lower()).translate(str.maketrans('أإآى', 'اااي'))
    words = re.findall(r'[^\W\d_]+', text, flags=re.UNICODE)
    return {word[2:] if word.startswith('ال') and len(word) > 3 else word for word in words} & FEATURES


def initial_state():
    return {'version': 1, 'cursor': 0, 'classes': {label: {'docs': 0, 'tokens': {}} for label in CLASSES},
            'sources': []}


def valid_url(url):
    if not isinstance(url, str) or len(url) > 1200:
        return False
    p = urlsplit(url)
    return p.scheme == 'https' and p.hostname in ('ar.wikipedia.org', 'en.wikipedia.org') and not p.username and not p.password and p.path.startswith('/wiki/') and not p.query and not p.fragment


def validate_state(value):
    try:
        if value['version'] != 1 or type(value['cursor']) is not int or not 0 <= value['cursor'] < len(TOPICS):
            return False
        if set(value['classes']) != set(CLASSES) or len(value['sources']) > MAX_SOURCES:
            return False
        for data in value['classes'].values():
            if type(data['docs']) is not int or not 0 <= data['docs'] <= MAX_SOURCES or not isinstance(data['tokens'], dict):
                return False
            if any(word not in FEATURES or type(count) is not int or not 0 <= count <= data['docs'] for word, count in data['tokens'].items()):
                return False
        urls = set()
        for source in value['sources']:
            if source['label'] not in CLASSES or not isinstance(source['title'], str) or len(source['title']) > 120 or not valid_url(source['url']) or source['url'] in urls:
                return False
            if not isinstance(source['words'], list) or len(source['words']) > len(FEATURES) or len(set(source['words'])) != len(source['words']) or any(word not in FEATURES for word in source['words']):
                return False
            urls.add(source['url'])
        return sum(data['docs'] for data in value['classes'].values()) == len(value['sources'])
    except (KeyError, TypeError, ValueError):
        return False


class WikiLearner:
    def __init__(self, directory, get_json, user_agent, interval=300):
        self.file = os.path.join(directory, 'wiki-map-learning.json')
        self.get_json = get_json
        self.user_agent = user_agent
        self.interval = interval
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.status = 'starting'
        try:
            with open(self.file, encoding='utf-8') as f:
                data = json.load(f)
            self.state = data if validate_state(data) else initial_state()
        except (OSError, ValueError, TypeError):
            self.state = initial_state()

    def snapshot(self):
        with self.lock:
            return {**self.state, 'sources': [{k: item[k] for k in ('label', 'title', 'url')} for item in self.state['sources']], 'status': self.status}

    def learn_once(self):
        with self.lock:
            state = self.state
            cursor = state['cursor']
        label, query, title_pattern = TOPICS[cursor]
        language = 'ar' if re.search(r'[\u0600-\u06ff]', query) else 'en'
        host = f'{language}.wikipedia.org'
        target = f'https://{host}/w/rest.php/v1/search/page?' + urlencode({'q': query, 'limit': 4})
        try:
            payload = self.get_json(Request(target, headers={'User-Agent': self.user_agent}), timeout=25)
            if not isinstance(payload, dict) or not isinstance(payload.get('pages'), list):
                raise ValueError('invalid response')
            with self.lock:
                # Copy before writing; never leave a half-updated in-memory model.
                state = json.loads(json.dumps(self.state))
                known = {item['url'] for item in state['sources']}
                added = 0
                for page in payload['pages'][:4]:
                    if not isinstance(page, dict):
                        continue
                    title, key = page.get('title'), page.get('key')
                    if not isinstance(title, str) or not isinstance(key, str) or not key or not re.search(title_pattern, title, re.I):
                        continue
                    url = f'https://{host}/wiki/{quote(key, safe="/_():-")}'
                    if not valid_url(url) or url in known:
                        continue
                    excerpt = page.get('excerpt') or page.get('description') or ''
                    if not isinstance(excerpt, str):
                        continue
                    # HTML tags are ignored as words; only fixed map vocabulary is retained.
                    words = terms(title + ' ' + re.sub(r'<[^>]*>', ' ', excerpt[:1200]))
                    if not words:
                        continue
                    if len(state['sources']) >= MAX_SOURCES:
                        oldest = state['sources'].pop(0)
                        known.remove(oldest['url'])
                        previous = state['classes'][oldest['label']]
                        previous['docs'] -= 1
                        for word in oldest['words']:
                            previous['tokens'][word] -= 1
                            if not previous['tokens'][word]:
                                del previous['tokens'][word]
                    category = state['classes'][label]
                    category['docs'] += 1
                    for word in words:
                        category['tokens'][word] = category['tokens'].get(word, 0) + 1
                    state['sources'].append({'label': label, 'title': title[:120], 'url': url, 'words': sorted(words)})
                    known.add(url)
                    added += 1
                state['cursor'] = (cursor + 1) % len(TOPICS)
                tmp = self.file + '.tmp'
                with open(tmp, 'w', encoding='utf-8') as f:
                    json.dump(state, f, ensure_ascii=False)
                os.replace(tmp, self.file)
                self.state = state
                self.status = 'learning' if added else 'no_new_articles'
        except (OSError, ValueError, TypeError):
            with self.lock:
                self.status = 'unavailable'

    def run(self):
        while not self.stop_event.is_set():
            self.learn_once()
            self.stop_event.wait(self.interval)

    def start(self):
        threading.Thread(target=self.run, daemon=True, name='wiki-map-learner').start()

    def stop(self):
        self.stop_event.set()
