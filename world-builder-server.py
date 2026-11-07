#!/usr/bin/env python3
"""Loopback-only static server and fixed HTTPS proxy for the phone app.

The browser keeps the keys; this server forwards them only to the selected
service and never writes or logs them. No external dependencies are required.
"""
import argparse
import json
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener, HTTPRedirectHandler

ROUTES = {
    '/api/groq': 'https://api.groq.com/openai/v1/chat/completions',
    '/api/tavily': 'https://api.tavily.com/search',
}
MAX_REQUEST = 64 * 1024
MAX_RESPONSE = 2 * 1024 * 1024


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        # Paths and user-supplied query strings can contain secrets; avoid logs.
        pass

    def api_result(self, status, data):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-World-Builder-Proxy', '1')
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        # Reject unexpected Host/Origin, including cross-site and DNS-rebinding requests.
        port = self.server.server_address[1]
        allowed_hosts = {f'127.0.0.1:{port}', f'localhost:{port}'}
        host = self.headers.get('Host', '')
        if host not in allowed_hosts or self.headers.get('Origin', '') != f'http://{host}':
            self.api_result(403, b'{"error":"invalid origin"}')
            return
        target = ROUTES.get(self.path)
        if not target:
            self.api_result(404, b'{"error":"unknown endpoint"}')
            return
        if self.headers.get_content_type() != 'application/json':
            self.api_result(415, b'{"error":"JSON required"}')
            return
        authorization = self.headers.get('Authorization', '')
        if not authorization.startswith('Bearer ') or len(authorization) > 520:
            self.api_result(401, b'{"error":"missing key"}')
            return
        try:
            length = int(self.headers.get('Content-Length', '-1'))
            if length < 1 or length > MAX_REQUEST:
                raise ValueError('invalid length')
            payload = self.rfile.read(length)
            json.loads(payload)
        except (ValueError, UnicodeError):
            self.api_result(400, b'{"error":"invalid request"}')
            return
        request = Request(target, data=payload, method='POST', headers={
            'Content-Type': 'application/json', 'Authorization': authorization,
        })
        try:
            # No redirects: bearer keys must never be forwarded to another host.
            with build_opener(NoRedirects()).open(request, timeout=80) as response:
                body = response.read(MAX_RESPONSE + 1)
                if len(body) > MAX_RESPONSE:
                    self.api_result(502, b'{"error":"response too large"}')
                    return
                self.api_result(response.status, body)
        except HTTPError as error:
            # Do not forward arbitrary upstream error text or any authentication headers.
            self.api_result(error.code, b'{"error":"upstream rejected request"}')
        except (URLError, TimeoutError, OSError):
            self.api_result(502, b'{"error":"upstream unavailable"}')


def main():
    parser = argparse.ArgumentParser(description='World Builder local phone server')
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--directory', default=os.path.dirname(os.path.abspath(__file__)))
    args = parser.parse_args()
    handler = partial(Handler, directory=args.directory)
    with ThreadingHTTPServer(('127.0.0.1', args.port), handler) as server:
        print(f'افتح http://127.0.0.1:{args.port}/world-builder-mobile.html', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
