"""Tests for phone server endpoints; all upstream network calls are mocked."""
import http.client
import importlib.util
import json
import os
import threading
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import Request
from email.message import Message

spec = importlib.util.spec_from_file_location('phone_server', 'world-builder-server.py')
phone_server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(phone_server)


class PhoneServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), phone_server.Handler)
        cls.server.wiki_learner = type('StubLearner', (), {'snapshot': lambda self: {'status': 'learning'}})()
        cls.server.house_learner = type('StubHouse', (), {'snapshot': lambda self: {'samples': 2}})()
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.thread.join()
        cls.server.server_close()

    def request(self, path, origin=None, host=None, content_type='application/json', body=None, method='POST', extra_headers=None):
        port = self.server.server_address[1]
        host = host or f'127.0.0.1:{port}'
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
        headers = {'Host': host, 'Origin': origin or f'http://{host}', 'Content-Type': content_type}
        if extra_headers: headers.update(extra_headers)
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

    def test_vision_files_are_explicitly_allowlisted_with_correct_mime_types(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory:
            for path in phone_server.VISION_FILES:
                file = Path(directory) / path.lstrip('/')
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(b'local model')
            with patch.object(phone_server.Handler, 'translate_path', side_effect=lambda path: str(Path(directory) / path.lstrip('/'))):
                port = self.server.server_address[1]
                for path, mime in [('/vision-worker.js','text/javascript'),
                    ('/vision/ort.wasm.min.js','text/javascript'),
                    ('/vision/ort-wasm-simd-threaded.mjs','text/javascript'),
                    ('/vision/ort-wasm-simd-threaded.wasm','application/wasm'),
                    ('/vision/scene.onnx','application/octet-stream')]:
                    conn=http.client.HTTPConnection('127.0.0.1',port,timeout=5)
                    conn.request('GET',path,headers={'Host':f'127.0.0.1:{port}'})
                    response=conn.getresponse()
                    self.assertEqual(response.status,200,path)
                    self.assertEqual(response.getheader('Content-Type'),mime,path)
                    self.assertEqual(response.read(),b'local model')
                    conn.close()
                    self.assertEqual(self.request(path,host='evil.example',method='GET')[0],404)
                    self.assertEqual(self.request(path+'?x=1',method='GET')[0],404)
                for path in ['/vision/', '/vision/secret', '/vision/../world-builder-server.py', '/vision-setup.py']:
                    self.assertEqual(self.request(path,method='GET')[0],404,path)

    @patch.object(phone_server, 'get_image')
    def test_thumbnail_proxy_validates_origin_url_format_size_and_does_not_redirect(self, upstream):
        from urllib.parse import urlencode
        url = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Thing.png/240px-Thing.png'
        path = '/api/image-thumbnail?' + urlencode({'url': url})
        png = b'\x89PNG\r\n\x1a\nexample'
        upstream.return_value = png
        status, body = self.request(path, method='GET')
        self.assertEqual((status, body), (200, png))
        self.assertEqual(upstream.call_args.args[0].full_url, url)
        upstream.reset_mock()
        self.assertEqual(self.request(path, method='GET', origin='https://evil.example')[0], 403)
        self.assertEqual(self.request(path, method='GET', extra_headers={'Sec-Fetch-Site':'cross-site'})[0], 403)
        self.assertEqual(self.request(path, method='GET', host='evil.example')[0], 404)
        for bad in ('http://127.0.0.1/x', 'https://evil.example/wikipedia/commons/thumb/240px-a.png',
                    'https://upload.wikimedia.org/wikipedia/commons/a/original.png', url + '?secret=1'):
            self.assertEqual(self.request('/api/image-thumbnail?' + urlencode({'url': bad}), method='GET')[0], 400)
        self.assertEqual(self.request(path + '&url=' + urlencode({'x':url})[2:], method='GET')[0], 400)
        self.assertEqual(self.request('/api/image-thumbnail?x=1', method='GET')[0], 400)
        upstream.assert_not_called()
        upstream.return_value = b'not an image'
        self.assertEqual(self.request(path, method='GET')[0], 400)
        upstream.return_value = b'\x89PNG\r\n\x1a\n' + b'x' * 1_000_000
        self.assertEqual(self.request(path, method='GET')[0], 400)
        upstream.side_effect = HTTPError(url, 302, 'redirect', {}, None)
        self.assertEqual(self.request(path, method='GET')[0], 502)

    def test_knowledge_endpoint(self):
        status, body = self.request('/api/knowledge')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['status'], 'learning')
        status, body = self.request('/api/house-learning')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['samples'], 2)

    @unittest.skipIf(__import__('house_learner').Image is None, 'Pillow needed for image pixels')
    @patch.object(phone_server, 'get_image')
    def test_image_pixels_are_bounded_and_reject_untrusted_urls(self, upstream):
        import io
        import base64
        from PIL import Image
        image = Image.new('RGBA', (96, 48), (100, 25, 30, 255))
        out = io.BytesIO(); image.save(out, format='PNG')
        upstream.return_value = out.getvalue()
        url = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Thing.png/240px-Thing.png'
        status, body = self.request('/api/image-pixels', body=json.dumps({'url': url}).encode())
        self.assertEqual(status, 200)
        result = json.loads(body)
        self.assertEqual((result['width'], result['height']), (24, 12))
        self.assertEqual(len(base64.b64decode(result['rgba'])), 24 * 12 * 4)
        self.assertEqual(upstream.call_args.args[0].full_url, url)
        upstream.reset_mock()
        for bad in ['https://evil.example/240px-Thing.png', 'http://127.0.0.1/a', 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Thing.png', url + '?bad=1']:
            self.assertEqual(self.request('/api/image-pixels', body=json.dumps({'url': bad}).encode())[0], 400)
        self.assertEqual(self.request('/api/image-pixels', origin='https://evil.example', body=json.dumps({'url': url}).encode())[0], 403)
        upstream.assert_not_called()
        upstream.return_value = b'not an image'
        self.assertEqual(self.request('/api/image-pixels', body=json.dumps({'url': url}).encode())[0], 502)

    @patch.object(phone_server, 'get_image')
    @patch.object(phone_server, 'get_json')
    def test_real_imageinfo_250px_thumb_host_and_tracking_parameters(self, wiki, image):
        # Representative fields copied from a live Commons imageinfo response.
        from urllib.parse import urlencode
        thumb = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/8/83/Elephant_running.jpg/250px-Elephant_running.jpg'
        api_thumb = thumb + '?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail'
        wiki.return_value = {'query': {'pages': [{'title':'File:Elephant running.jpg', 'index':3, 'imageinfo':[{
            'mime':'image/jpeg', 'thumburl':api_thumb, 'thumbwidth':240,
            'extmetadata': {'LicenseUrl':{'value':'https://creativecommons.org/licenses/by-sa/4.0'}, 'Artist':{'value':'Byrdyak'}}
        }]}]}}
        status, body = self.request('/api/image-search', body=b'{"query":"elephant"}')
        self.assertEqual(status, 200)
        found = json.loads(body)['results']
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]['thumbnail'], thumb)
        self.assertEqual(found[0]['license_url'], 'https://creativecommons.org/licenses/by-sa/4.0/')
        image.return_value = b'\xff\xd8\xffcontent'
        status, body = self.request('/api/image-thumbnail?' + urlencode({'url':thumb}), method='GET')
        self.assertEqual((status, body), (200, image.return_value))
        self.assertEqual(image.call_args.args[0].full_url, thumb)
        for bad in [api_thumb, thumb.replace('thumb.wikimedia.org', 'thumb.wikimedia.org.evil.example'),
                    thumb.replace('/250px-', '/500px-'), thumb.replace('/8/83/', '/8/83/%2e%2e/'),
                    thumb.replace('https://thumb.wikimedia.org/', 'https://user@thumb.wikimedia.org/')]:
            self.assertEqual(self.request('/api/image-thumbnail?' + urlencode({'url':bad}), method='GET')[0], 400)
        for query in ['?x=1', '?utm_source=evil&utm_campaign=imageinfo&utm_content=thumbnail']:
            wiki.return_value['query']['pages'][0]['imageinfo'][0]['thumburl'] = thumb + query
            self.assertEqual(json.loads(self.request('/api/image-search', body=b'{"query":"elephant"}')[1])['results'], [])

    @patch.object(phone_server, 'build_opener')
    def test_image_downloader_accepts_only_trusted_thumb_host_and_bounds_bytes(self, opener):
        import io
        class Response(io.BytesIO):
            def __init__(self, data, content_type):
                super().__init__(data)
                self.headers = Message()
                self.headers['Content-Type'] = content_type
        thumb = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/8/83/Elephant_running.jpg/250px-Elephant_running.jpg'
        opener.return_value.open.return_value = Response(b'jpeg', 'image/jpeg')
        self.assertEqual(phone_server.get_image(Request(thumb), timeout=25), b'jpeg')
        self.assertIsInstance(opener.call_args.args[0], phone_server.NoRedirects)
        opener.return_value.open.return_value = Response(b'x' * 1_000_001, 'image/jpeg')
        with self.assertRaises(ValueError): phone_server.get_image(Request(thumb), timeout=25)
        opener.return_value.open.return_value = Response(b'<svg/>', 'image/svg+xml')
        with self.assertRaises(ValueError): phone_server.get_image(Request(thumb), timeout=25)
        opener.reset_mock()
        with self.assertRaises(ValueError): phone_server.get_image(Request(thumb.replace('thumb.wikimedia.org','evil.example')), timeout=25)
        opener.assert_not_called()

    @unittest.skipIf(__import__('house_learner').Image is None, 'Pillow needed for image pixels')
    @patch.object(phone_server, 'get_image')
    def test_modern_thumbnail_is_also_accepted_for_pixel_conversion(self, upstream):
        import io
        from PIL import Image
        out = io.BytesIO(); Image.new('RGB', (250, 150), (10, 20, 30)).save(out, format='JPEG')
        upstream.return_value = out.getvalue()
        thumb = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/8/83/Elephant_running.jpg/250px-Elephant_running.jpg'
        status, body = self.request('/api/image-pixels', body=json.dumps({'url':thumb}).encode())
        self.assertEqual(status, 200)
        self.assertEqual((json.loads(body)['width'], json.loads(body)['height']), (24, 14))

    @patch.object(phone_server, 'get_json')
    def test_connectivity_and_search_are_fixed_to_wikipedia(self, upstream):
        upstream.return_value = {'query': {}}
        self.assertEqual(self.request('/api/online')[0], 200)
        self.assertEqual(upstream.call_args.args[0].full_url, phone_server.ONLINE_URL)
        upstream.return_value = {'query': {'search': [{'title': 'Some place', 'snippet': 'A <b>real</b> place'},
                                          {'title': 'Test', 'snippet': ''}]}, 'continue': {'sroffset': 20, 'continue': '-||'}}
        status, body = self.request('/api/search', body=b'{"query":"test"}')
        self.assertEqual(status, 200)
        self.assertTrue(upstream.call_args.args[0].full_url.startswith('https://en.wikipedia.org/w/api.php?'))
        result = json.loads(body)['results']
        self.assertEqual(result[0]['content'], 'A real place')
        self.assertEqual(result[0]['url'], 'https://en.wikipedia.org/wiki/Some_place')
        self.assertTrue(result[1]['url'].startswith('https://en.wikipedia.org/wiki/'))
        self.assertEqual(json.loads(body)['next'], 20)
        self.request('/api/search', body=b'{"query":"test","offset":20}')
        self.assertIn('sroffset=20', upstream.call_args.args[0].full_url)
        for bad in (-1, '20', True, 2147483648):
            self.assertEqual(self.request('/api/search', body=json.dumps({'query':'x','offset':bad}).encode())[0], 400)
        self.request('/api/search', body=json.dumps({'query': 'الصحراء'}).encode())
        self.assertTrue(upstream.call_args.args[0].full_url.startswith('https://ar.wikipedia.org/'))

    @patch.object(phone_server, 'get_json')
    def test_reads_bounded_article_intro_from_fixed_host(self, upstream):
        from urllib.parse import parse_qs, urlsplit
        upstream.return_value = {'query': {'pages': [{'title': 'فيل', 'extract': 'حيوان' * 400}]}}
        status, body = self.request('/api/wiki-article', body=json.dumps({'query': 'فيل'}).encode())
        self.assertEqual(status, 200)
        article = json.loads(body)['article']
        self.assertEqual(article['title'], 'فيل')
        self.assertEqual(len(article['content']), 1200)
        url = urlsplit(upstream.call_args.args[0].full_url)
        self.assertEqual(url.hostname, 'ar.wikipedia.org')
        self.assertEqual(parse_qs(url.query)['titles'], ['فيل'])
        self.assertEqual(parse_qs(url.query)['explaintext'], ['1'])
        self.assertEqual(self.request('/api/wiki-article', origin='https://evil.example', body=b'{"query":"x"}')[0], 403)
        upstream.return_value = {'query': {'pages': [{'missing': True}]}}
        self.assertIsNone(json.loads(self.request('/api/wiki-article', body=b'{"query":"x"}')[1])['article'])

    @patch.object(phone_server, 'get_json')
    def test_translate_en_uses_fixed_wikipedia_host_and_language_links(self, upstream):
        from urllib.parse import parse_qs, urlsplit
        upstream.return_value = {'query': {'pages': [{'title': 'فيل', 'langlinks': [{'lang': 'en', 'title': 'Elephant'}]}]}}
        status, body = self.request('/api/translate-en', body=json.dumps({'query': 'فيل'}).encode())
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {'title': 'Elephant'})
        url = urlsplit(upstream.call_args.args[0].full_url)
        self.assertEqual(url.hostname, 'ar.wikipedia.org')
        params = parse_qs(url.query)
        self.assertEqual(params['titles'], ['فيل'])
        self.assertEqual(params['lllang'], ['en'])
        self.assertEqual(self.request('/api/translate-en', origin='https://evil.example', body=b'{"query":"x"}')[0], 403)
        upstream.return_value = {'query': {'pages': [{'title': 'فيل'}]}}
        self.assertIsNone(json.loads(self.request('/api/translate-en', body=json.dumps({'query':'فيل'}).encode())[1])['title'])

    @patch.object(phone_server, 'get_json')
    def test_multilingual_dictionary_is_bounded_and_uses_fixed_upstream(self, upstream):
        upstream.return_value = {
            'fr': [{'partOfSpeech': 'Noun', 'definitions': [{'definition': '<b>A small house.</b>'}]}],
            'ar': [{'partOfSpeech': 'Noun', 'definitions': [{'definition': 'A home.'}]}],
            'en': [{'partOfSpeech': 'Noun', 'definitions': [{'definition': 'A hut.'}]}],
            'de': [{'partOfSpeech': 'Noun', 'definitions': [{'definition': 'ignored'}]}],
        }
        for word in ('cabane', 'maison', 'بيت'):
            status, body = self.request('/api/dictionary', body=json.dumps({'query': word}).encode())
            self.assertEqual(status, 200)
            result = json.loads(body)
            self.assertEqual([entry['language'] for entry in result['entries']], ['ar', 'fr', 'en'])
            self.assertEqual(result['entries'][1]['definition'], 'A small house.')
            self.assertTrue(result['complete'])
            self.assertTrue(upstream.call_args.args[0].full_url.startswith(phone_server.DICTIONARY_API))
        upstream.reset_mock()
        for word in ('https://evil.example', '../a', 'two words', 'x' * 81):
            self.assertEqual(self.request('/api/dictionary', body=json.dumps({'query': word}).encode())[0], 400)
        self.assertEqual(self.request('/api/dictionary', origin='https://evil.example')[0], 403)
        upstream.assert_not_called()
        upstream.return_value = {'fr': [{'partOfSpeech': 'Noun', 'definitions': [{'definition': 'house'}] * 9}]}
        status, body = self.request('/api/dictionary', body=b'{"query":"cabane"}')
        self.assertEqual(status, 200)
        self.assertFalse(json.loads(body)['complete'])
        upstream.side_effect = HTTPError('https://en.wiktionary.org', 404, 'Not found', {}, None)
        self.assertEqual(json.loads(self.request('/api/dictionary', body=b'{"query":"cabane"}')[1]), {'entries': [], 'complete': True})

    @patch.object(phone_server, 'get_json')
    def test_commons_image_search_restricts_types_sources_and_licenses(self, upstream):
        info = {'mime': 'image/jpeg', 'thumburl': 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Castle.jpg/240px-Castle.jpg',
                'extmetadata': {'LicenseUrl': {'value': 'http://creativecommons.org/licenses/by-sa/4.0/'},
                                'Artist': {'value': '<b>Alice</b>'}, 'LicenseShortName': {'value': 'misleading'}}}
        import copy
        good = {'title': 'File:Castle.jpg', 'imageinfo': [info]}
        bad_license = copy.deepcopy(good); bad_license['title'] = 'File:Bad.jpg'; bad_license['imageinfo'][0]['extmetadata']['LicenseUrl']['value'] = 'https://evil.example/license'
        bad_thumb = copy.deepcopy(good); bad_thumb['title'] = 'File:Bad2.jpg'; bad_thumb['imageinfo'][0]['thumburl'] = 'https://evil.example/wikipedia/commons/thumb/a/240px-x.jpg'
        no_author = copy.deepcopy(good); no_author['title'] = 'File:NoAuthor.jpg'; no_author['imageinfo'][0]['extmetadata']['Artist']['value'] = ''
        wrong_mime = copy.deepcopy(good); wrong_mime['title'] = 'File:Vector.svg'; wrong_mime['imageinfo'][0]['mime'] = 'image/svg+xml'
        original = copy.deepcopy(good); original['title'] = 'File:Original.jpg'; original['imageinfo'][0]['thumburl'] = 'https://upload.wikimedia.org/wikipedia/commons/a/a1/Original.jpg'
        cc0 = copy.deepcopy(no_author); cc0['title'] = 'File:CC0.jpg'; cc0['imageinfo'][0]['extmetadata']['LicenseUrl']['value'] = 'https://creativecommons.org/publicdomain/zero/1.0/'
        upstream.return_value = {'query': {'pages': [good, bad_license, bad_thumb, no_author, wrong_mime, original, cc0]}, 'continue': {'gsroffset': 15, 'continue': 'gsroffset||'}}
        status, body = self.request('/api/image-search', body=json.dumps({'query': 'قلعة'}).encode())
        self.assertEqual(status, 200)
        self.assertTrue(upstream.call_args.args[0].full_url.startswith(phone_server.COMMONS_API))
        result = json.loads(body)['results']
        self.assertEqual([x['title'] for x in result], ['File:Castle.jpg', 'File:CC0.jpg'])
        self.assertEqual(result[0]['author'], 'Alice')
        self.assertEqual(result[0]['license_name'], 'CC BY-SA 4.0')
        self.assertEqual(result[0]['license_url'], 'https://creativecommons.org/licenses/by-sa/4.0/')
        self.assertEqual(result[1]['license_name'], 'CC0')
        self.assertEqual(json.loads(body)['next'], 15)
        # Commons may omit the trailing slash; canonicalize only known free licenses.
        no_slash = copy.deepcopy(good); no_slash['imageinfo'][0]['extmetadata']['LicenseUrl']['value'] = 'https://creativecommons.org/licenses/by-sa/4.0'
        upstream.return_value = {'query': {'pages': [no_slash]}}
        no_slash_result = json.loads(self.request('/api/image-search', body=b'{"query":"castle"}')[1])['results']
        self.assertEqual(no_slash_result[0]['license_url'], 'https://creativecommons.org/licenses/by-sa/4.0/')
        upstream.return_value = {'query': {'pages': [good, bad_license, bad_thumb, no_author, wrong_mime, original, cc0]}, 'continue': {'gsroffset': 15, 'continue': 'gsroffset||'}}
        status, body = self.request('/api/image-search', body=b'{"query":"castle","offset":15}')
        self.assertEqual(status, 200)
        self.assertIn('gsroffset=15', upstream.call_args.args[0].full_url)
        self.assertIsNone(json.loads(body)['next'])
        self.assertEqual(self.request('/api/image-search', body=b'{"query":"castle","offset":-1}')[0], 400)
        self.assertEqual(self.request('/api/image-search', body=b'{"query":""}')[0], 400)
        self.assertEqual(self.request('/api/image-search', origin='https://evil.example')[0], 403)

    @patch.object(phone_server, 'get_json')
    def test_rejects_cross_origin_host_wrong_type_and_bad_routes(self, upstream):
        self.assertEqual(self.request('/api/online', origin='https://evil.example')[0], 403)
        self.assertEqual(self.request('/api/house-learning', origin='https://evil.example')[0], 403)
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
        for path in ('/api/online', '/api/search', '/api/image-search', '/api/dictionary'):
            status, body = self.request(path)
            self.assertEqual(status, 502)
            self.assertNotIn(b'secret', body)

    def test_image_download_rejects_untrusted_url_type_and_size(self):
        with self.assertRaises(ValueError):
            phone_server.get_image(Request('https://example.org/wikipedia/commons/x'), timeout=1)
        class Reply:
            def __init__(self, content_type, body):
                self.headers = Message()
                self.headers['Content-Type'] = content_type
                self.body = body
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, n): return self.body[:n]
        class Opener:
            def __init__(self, reply): self.reply = reply
            def open(self, req, timeout): return self.reply
        request = Request('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/a.png/192px-a.png')
        for reply in (Reply('text/html', b'<html>'), Reply('image/png', b'x' * 1_000_001)):
            with patch.object(phone_server, 'build_opener', return_value=Opener(reply)):
                with self.assertRaises(ValueError): phone_server.get_image(request, timeout=1)
        with patch.object(phone_server, 'build_opener', return_value=Opener(Reply('image/png', b'png'))):
            self.assertEqual(phone_server.get_image(request, timeout=1), b'png')

    @unittest.skipIf(__import__('house_learner').Image is None, 'Pillow needed for image analysis')
    @patch.object(phone_server, 'get_image')
    def test_analyzes_bounded_thumbnail_color_without_storing_it(self, downloader):
        from PIL import Image
        import io
        image = Image.new('RGB', (64, 64), (0, 0, 255))
        for y in range(16, 48):
            for x in range(16, 48): image.putpixel((x, y), (190, 40, 30))
        raw = io.BytesIO(); image.save(raw, format='PNG'); downloader.return_value = raw.getvalue()
        url = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/a.png/240px-a.png'
        status, body = self.request('/api/image-analyze', body=json.dumps({'url': url}).encode())
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {'center_color': '#be281e'})
        self.assertEqual(downloader.call_args.args[0].full_url, url)
        self.assertEqual(self.request('/api/image-analyze', body=b'{"url":"https://evil.example/a"}')[0], 400)
        self.assertEqual(self.request('/api/image-analyze', origin='https://evil.example', body=json.dumps({'url': url}).encode())[0], 403)
        downloader.return_value = b'not an image'
        self.assertEqual(self.request('/api/image-analyze', body=json.dumps({'url': url}).encode())[0], 502)

    @patch.object(phone_server, 'analyze_reference_image', side_effect=RuntimeError('missing pillow'))
    def test_image_analysis_explains_missing_pillow(self, analyzer):
        url = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/a.png/240px-a.png'
        status, body = self.request('/api/image-analyze', body=json.dumps({'url': url}).encode())
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body)['error'], 'missing_pillow')

    def test_cloud_endpoint_requires_consentful_same_origin_and_never_falls_back(self):
        prompt = json.dumps({'query': 'a copper robot'}).encode()
        self.assertEqual(self.request('/api/text-to-3d', origin='https://evil.example', body=prompt)[0], 403)
        self.assertEqual(self.request('/api/text-to-3d', body=b'{"query":"a", "url":"https://evil.example"}')[0], 400)
        self.assertEqual(self.request('/api/text-to-3d', body=json.dumps({'query': 'x'*401}).encode())[0], 400)
        with patch.object(phone_server, 'fetch_cloud_3d', return_value=b'glTF' + bytes(32)) as generate:
            status, content = self.request('/api/text-to-3d', body=prompt)
            self.assertEqual(status, 200)
            self.assertEqual(content, b'glTF' + bytes(32))
            generate.assert_called_once_with('a copper robot')
        with patch.object(phone_server, 'fetch_cloud_3d', side_effect=ValueError('quota')):
            self.assertEqual(self.request('/api/text-to-3d', body=prompt)[0], 502)
        with phone_server.CLOUD_3D_LOCK:
            self.assertEqual(self.request('/api/text-to-3d', body=prompt)[0], 429)

    def test_asset_library_endpoints_reject_cross_origin_and_invalid_input(self):
        search=json.dumps({'query':'tree'}).encode()
        self.assertEqual(self.request('/api/asset-library/search', origin='https://evil.example',body=search)[0],403)
        self.assertEqual(self.request('/api/asset-library/search',body=b'{"query":"tree","url":"http://bad"}')[0],400)
        self.assertEqual(self.request('/api/asset-library/search',body=json.dumps({'query':'x'*201}).encode())[0],400)
        with patch.object(phone_server,'search_free_models',return_value={'results': []}) as searcher:
            self.assertEqual(self.request('/api/asset-library/search',body=search)[0],200)
            searcher.assert_called_once_with('tree')
        self.assertEqual(self.request('/api/asset-library/model',body=b'{"id":"../x","version":"1"}')[0],400)
        self.assertEqual(self.request('/api/asset-library/model',body=b'{"id":"1","version":"1","url":"x"}')[0],400)
        with patch.object(phone_server,'download_free_model',return_value=b'glTF'+bytes(24)) as loader:
            self.assertEqual(self.request('/api/asset-library/model',body=b'{"id":"1","version":"2"}')[1],b'glTF'+bytes(24))
            loader.assert_called_once_with('1','2')

    def test_redirects_are_not_followed(self):
        self.assertIsNone(phone_server.NoRedirects().redirect_request(None, None, 302, '', {}, 'https://example.com'))


class Cloud3DTests(unittest.TestCase):
    def test_cloud_queue_download_is_fixed_host_and_bounded(self):
        import io
        model = b'glTF' + b'\0' * 40
        completed = b'event: heartbeat\ndata: null\n\nevent: complete\ndata: [{"url":"https://hysts-shap-e.hf.space/gradio_api/file=/tmp/gradio/abc/result.glb"}]\n\n'
        class FakeOpener:
            def __init__(self): self.requests=[]
            def open(self, req, timeout):
                self.requests.append(req)
                if len(self.requests)==1: return io.BytesIO(b'{"event_id":"good_123"}')
                if len(self.requests)==2: return io.BytesIO(completed)
                return io.BytesIO(model)
        opener=FakeOpener()
        with patch.object(phone_server, 'build_opener', return_value=opener):
            self.assertEqual(phone_server.fetch_cloud_3d('a robot'), model)
        self.assertEqual(opener.requests[0].full_url, phone_server.CLOUD_3D_URL + '/gradio_api/call/v2/text-to-3d')
        self.assertEqual(json.loads(opener.requests[0].data)['prompt'], 'a robot')
        self.assertTrue(all(req.full_url.startswith(phone_server.CLOUD_3D_URL + '/') for req in opener.requests))

    def test_cloud_never_fetches_an_untrusted_result_url(self):
        import io
        class FakeOpener:
            def __init__(self): self.n=0
            def open(self, req, timeout):
                self.n+=1
                if self.n==1: return io.BytesIO(b'{"event_id":"123"}')
                return io.BytesIO(b'event: complete\ndata: [{"url":"https://evil.example/result.glb"}]\n')
        opener=FakeOpener()
        with patch.object(phone_server, 'build_opener', return_value=opener):
            with self.assertRaises(ValueError): phone_server.fetch_cloud_3d('robot')
        self.assertEqual(opener.n, 2)

    def test_cloud_does_not_follow_malicious_event_id(self):
        import io
        class FakeOpener:
            def open(self, req, timeout): return io.BytesIO(b'{"event_id":"../../other"}')
        with patch.object(phone_server, 'build_opener', return_value=FakeOpener()):
            with self.assertRaises(ValueError): phone_server.fetch_cloud_3d('robot')


class FreeModelTests(unittest.TestCase):
    def test_search_filters_untrusted_or_incompatible_assets(self):
        from copy import deepcopy
        good={'id':'123','slug':'red-tree','title':'Red tree','status':'published','cdnUrl':'https://cdn.3dassets.dev/assets/123/v1/model.glb','license':{'slug':'cc0-1.0'},'stats':{'fileSize':1000,'triangles':200,'vertices':250,'meshes':2,'textures':0,'animations':[],'extensionsUsed':['KHR_mesh_quantization']}}
        def bad(key,value):
            x=deepcopy(good);x[key]=value;return x
        textured=deepcopy(good);textured['stats']['textures']=1
        heavy=deepcopy(good);heavy['stats']['triangles']=10001
        compressed=deepcopy(good);compressed['stats']['extensionsUsed']=['KHR_draco_mesh_compression']
        with patch.object(phone_server,'get_json',return_value={'data':[good,bad('cdnUrl','https://evil.example/assets/123/v1/model.glb'),bad('license',{'slug':'cc-by'}),textured,heavy,compressed]}) as get:
            results=phone_server.search_free_models('tree & rock')
        self.assertEqual(results['results'],[{'id':'123','version':'1','slug':'red-tree','title':'Red tree','triangles':200}])
        self.assertTrue(get.call_args.args[0].full_url.startswith(phone_server.ASSET_SEARCH_URL+'?'))
        self.assertIn('tree+%26+rock',get.call_args.args[0].full_url)

    def test_download_constructs_fixed_url_and_limits_response(self):
        import io
        class Opener:
            def __init__(self,data): self.data=data;self.url=None
            def open(self,req,timeout): self.url=req.full_url;return io.BytesIO(self.data)
        opener=Opener(b'glTF'+bytes(24))
        with patch.object(phone_server,'build_opener',return_value=opener):
            self.assertEqual(phone_server.download_free_model('123','2'),b'glTF'+bytes(24))
            self.assertEqual(opener.url,'https://cdn.3dassets.dev/assets/123/v2/model.glb')
            with self.assertRaises(ValueError):phone_server.download_free_model('../x','2')
        with patch.object(phone_server,'build_opener',return_value=Opener(b'glTF'+bytes(phone_server.MAX_LIBRARY_MODEL))):
            with self.assertRaises(ValueError):phone_server.download_free_model('1','1')


if __name__ == '__main__':
    unittest.main()
