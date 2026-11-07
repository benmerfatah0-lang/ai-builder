#!/usr/bin/env python3
"""Phone-only server: local llama.cpp plus limited Wikipedia search.

No API keys or paid services are used. Both HTTP listeners bind only to the
phone's loopback interface. Search requests go to Wikipedia over HTTPS.
"""
import argparse
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
from functools import partial
from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, build_opener, HTTPRedirectHandler

MAX_REQUEST = 64 * 1024
MAX_RESPONSE = 2 * 1024 * 1024
USER_AGENT = 'AIWorldBuilder/1.0 (https://github.com/benmerfatah0-lang/ai-builder)'
ONLINE_URL = 'https://ar.wikipedia.org/w/api.php?action=query&meta=siteinfo&siprop=general&format=json'


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


def choose_model_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


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
        if self.path not in ('/api/online', '/api/search', '/api/model'):
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
            if self.path == '/api/model':
                process = self.server.model_process
                if process is None or process.poll() is not None:
                    self.api_result(503, {'error': 'model not running'})
                    return
                target = f'http://127.0.0.1:{self.server.model_port}/v1/chat/completions'
                request = Request(target, data=json.dumps(payload).encode('utf-8'), method='POST', headers={
                    'Content-Type': 'application/json', 'Authorization': f'Bearer {self.server.model_key}',
                })
                self.api_result(200, get_json(request, timeout=570))
                return
            if self.path == '/api/online':
                response = get_json(Request(ONLINE_URL, headers={'User-Agent': USER_AGENT}), timeout=25)
                if not isinstance(response, dict) or 'query' not in response:
                    raise ValueError('invalid connectivity response')
                self.api_result(200, {'online': True})
                return
            query = payload.get('query')
            if not isinstance(query, str) or not query.strip() or len(query) > 400:
                self.api_result(400, {'error': 'invalid query'})
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
            self.api_result(503 if self.path == '/api/model' else 502, {'error': 'service unavailable'})


def main():
    parser = argparse.ArgumentParser(description='World Builder local phone server')
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--directory', default=os.path.dirname(os.path.abspath(__file__)))
    parser.add_argument('--model', default=None, help='path to the downloaded GGUF model')
    args = parser.parse_args()
    model = args.model or os.path.join(args.directory, 'model.gguf')
    binary = shutil.which('llama-server')
    if not binary:
        print('لم يُعثر على llama-server. ثبّت الحزمة: pkg install llama-cpp', file=sys.stderr)
        return 1
    if not os.path.isfile(model):
        print('ملف النموذج model.gguf غير موجود. نزّله أولاً باتباع التعليمات.', file=sys.stderr)
        return 1
    handler = partial(Handler, directory=args.directory)
    with ThreadingHTTPServer(('127.0.0.1', args.port), handler) as server:
        server.model_port = choose_model_port()
        server.model_key = secrets.token_urlsafe(32)
        try:
            server.model_process = subprocess.Popen([
                binary, '-m', model, '--alias', 'world-builder', '--host', '127.0.0.1',
                '--port', str(server.model_port), '--api-key', server.model_key,
                '-c', '4096', '-t', '4', '--parallel', '1', '-ngl', '0',
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            print('تعذّر بدء llama-server. تحقّق من تثبيت llama-cpp.', file=sys.stderr)
            return 1
        print(f'افتح http://127.0.0.1:{args.port}/world-builder-mobile.html', flush=True)
        print('النموذج يبدأ على الهاتف؛ قد يستغرق تحميله بعض الوقت. لإيقافه اضغط Ctrl+C.', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.model_process.terminate()
            try:
                server.model_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.model_process.kill()
                server.model_process.wait()
    return 0


if __name__ == '__main__':
    sys.exit(main())
