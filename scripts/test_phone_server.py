"""Tests for phone server endpoints; all upstream network calls are mocked."""
import http.client
import importlib.util
import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from urllib.error import URLError

spec = importlib.util.spec_from_file_location('phone_server', 'world-builder-server.py')
phone_server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(phone_server)


class PhoneServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), phone_server.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join()
        cls.server.server_close()

    def request(self, path, origin=None, host=None, content_type='application/json', body=None, method='POST'):
        port = self.server.server_address[1]
        host = host or f'127.0.0.1:{port}'
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
        headers = {'Host': host, 'Origin': origin or f'http://{host}', 'Content-Type': content_type}
        conn.request(method, path, body=body if body is not None else b'{"query":"test"}', headers=headers)
        result = conn.getresponse()
        status, contents = result.status, result.read()
        conn.close()
        return status, contents

    def test_serves_only_mobile_file(self):
        status, body = self.request('/world-builder-mobile.html', method='GET')
        self.assertEqual(status, 200)
        self.assertGreater(len(body), 1000)
        self.assertEqual(self.request('/', method='GET')[0], 404)
        self.assertEqual(self.request('/model.gguf', method='GET')[0], 404)
        self.assertEqual(self.request('/world-builder-mobile.html', host='evil.example', method='GET')[0], 404)

    @patch.object(phone_server, 'get_json')
    def test_connectivity_and_search_are_fixed_to_wikipedia(self, upstream):
        upstream.return_value = {'query': {}}
        self.assertEqual(self.request('/api/online')[0], 200)
        self.assertEqual(upstream.call_args.args[0].full_url, phone_server.ONLINE_URL)
        upstream.return_value = {'pages': [{'key': 'Some_place', 'title': 'Some place', 'excerpt': 'A <b>real</b> place'},
                                          {'key': '../../evil?x=1', 'title': 'Test', 'excerpt': ''}]}
        status, body = self.request('/api/search', body=b'{"query":"test"}')
        self.assertEqual(status, 200)
        self.assertTrue(upstream.call_args.args[0].full_url.startswith('https://en.wikipedia.org/w/rest.php/v1/search/page?'))
        result = json.loads(body)['results']
        self.assertEqual(result[0]['content'], 'A real place')
        self.assertEqual(result[0]['url'], 'https://en.wikipedia.org/wiki/Some_place')
        self.assertTrue(result[1]['url'].startswith('https://en.wikipedia.org/wiki/'))
        self.request('/api/search', body=json.dumps({'query': 'الصحراء'}).encode())
        self.assertTrue(upstream.call_args.args[0].full_url.startswith('https://ar.wikipedia.org/'))

    @patch.object(phone_server, 'get_json')
    def test_rejects_cross_origin_host_wrong_type_and_bad_routes(self, upstream):
        self.assertEqual(self.request('/api/online', origin='https://evil.example')[0], 403)
        self.assertEqual(self.request('/api/online', host='evil.example')[0], 403)
        self.assertEqual(self.request('/api/online', content_type='text/plain')[0], 415)
        self.assertEqual(self.request('/api/unknown')[0], 404)
        self.assertEqual(self.request('/api/model')[0], 404)
        self.assertEqual(self.request('/api/search', body=b'{"query":""}')[0], 400)
        self.assertEqual(self.request('/api/search', body=b'not json')[0], 400)
        self.assertEqual(self.request('/api/search', body=b'x' * (phone_server.MAX_REQUEST + 1))[0], 400)
        upstream.assert_not_called()

    @patch.object(phone_server, 'get_json', side_effect=URLError('secret network error'))
    def test_no_silent_network_fallback_or_secret_leak(self, upstream):
        for path in ('/api/online', '/api/search'):
            status, body = self.request(path)
            self.assertEqual(status, 502)
            self.assertNotIn(b'secret', body)

    def test_redirects_are_not_followed(self):
        self.assertIsNone(phone_server.NoRedirects().redirect_request(None, None, 302, '', {}, 'https://example.com'))


if __name__ == '__main__':
    unittest.main()
