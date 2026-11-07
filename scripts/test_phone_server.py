"""Tests for the phone server. All upstream requests are mocked."""
import http.client
import importlib.util
import threading
import unittest
from unittest.mock import patch
from http.server import ThreadingHTTPServer

spec = importlib.util.spec_from_file_location('phone_server', 'world-builder-server.py')
phone_server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(phone_server)


class MockResponse:
    status = 200
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self, size): return b'{"ok":true}'


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

    def request(self, path, origin=None, host=None, content_type='application/json'):
        port = self.server.server_address[1]
        host = host or f'127.0.0.1:{port}'
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
        conn.request('POST', path, body=b'{"query":"test"}', headers={
            'Host': host, 'Origin': origin or f'http://{host}',
            'Content-Type': content_type, 'Authorization': 'Bearer local-test-key',
        })
        result = conn.getresponse()
        status, body = result.status, result.read()
        conn.close()
        return status, body

    def test_serves_built_mobile_file(self):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_address[1], timeout=5)
        conn.request('HEAD', '/world-builder-mobile.html')
        response = conn.getresponse()
        self.assertEqual(response.status, 200)
        self.assertGreater(int(response.getheader('Content-Length')), 1000)
        response.read()
        conn.close()

    @patch.object(phone_server, 'build_opener')
    def test_fixed_routes_forward_only_to_the_right_service(self, opener):
        opener.return_value.open.return_value = MockResponse()
        status, body = self.request('/api/tavily')
        self.assertEqual((status, body), (200, b'{"ok":true}'))
        request = opener.return_value.open.call_args.args[0]
        self.assertEqual(request.full_url, 'https://api.tavily.com/search')
        self.assertEqual(request.get_header('Authorization'), 'Bearer local-test-key')
        self.request('/api/groq')
        self.assertEqual(opener.return_value.open.call_args.args[0].full_url,
                         'https://api.groq.com/openai/v1/chat/completions')

    @patch.object(phone_server, 'build_opener')
    def test_rejects_cross_origin_rebinding_wrong_type_and_unknown_route(self, opener):
        self.assertEqual(self.request('/api/groq', origin='https://evil.example')[0], 403)
        self.assertEqual(self.request('/api/groq', host='evil.example')[0], 403)
        self.assertEqual(self.request('/api/groq', content_type='text/plain')[0], 415)
        self.assertEqual(self.request('/api/unknown')[0], 404)
        opener.assert_not_called()

    @patch.object(phone_server, 'build_opener')
    def test_does_not_leak_upstream_errors(self, opener):
        from urllib.error import HTTPError
        opener.return_value.open.side_effect = HTTPError('https://example', 429, 'secret', {}, None)
        status, body = self.request('/api/groq')
        self.assertEqual(status, 429)
        self.assertNotIn(b'secret', body)
        self.assertNotIn(b'local-test-key', body)


if __name__ == '__main__':
    unittest.main()
