"""Offline tests; Commons and image download are replaced with local fixtures."""
import io
import os
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import URLError
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import house_learner as hl


@unittest.skipIf(hl.Image is None, 'Install Pillow to test image fitting')
class HouseLearnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        target = hl.render_house([1.65, 0.68, 1.35, 1.25])
        self.bytes = io.BytesIO()
        target.save(self.bytes, format='PNG')

    def fixture(self, license_url='https://creativecommons.org/licenses/by/4.0/', author='Test Author', url='https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/house.png/192px-house.png'):
        return {'query': {'pages': [{'title': 'File:Small cartoon house.png', 'imageinfo': [{
            'thumburl': url, 'extmetadata': {'LicenseUrl': {'value': license_url}, 'Artist': {'value': author},
                                             'ImageDescription': {'value': 'A small house drawing'}}}]}]}}

    def test_real_3d_projection_and_error_optimisation(self):
        image = hl.Image.open(io.BytesIO(self.bytes.getvalue()))
        params, final, before = hl.fit_house(image, seed=12)
        self.assertLess(final, before)
        self.assertTrue(all(lo <= v <= hi for v, (lo, hi) in zip(params, hl.LIMITS)))
        self.assertEqual((params, final, before), hl.fit_house(image, seed=12))

    def test_fixed_search_licensed_image_training_and_restart(self):
        calls = []
        def get_json(req, timeout): calls.append(req.full_url); return self.fixture()
        def get_image(req, timeout): calls.append(req.full_url); return self.bytes.getvalue()
        learner = hl.HouseLearner(self.tmp.name, get_json, get_image, 'Test')
        learner.learn_once()
        snapshot = learner.snapshot()
        self.assertEqual(snapshot['status'], 'learning')
        self.assertEqual(snapshot['samples'], 1)
        self.assertEqual(snapshot['profiles']['small']['count'], 1)
        self.assertEqual(snapshot['sources'][0]['author'], 'Test Author')
        self.assertTrue(calls[0].startswith('https://commons.wikimedia.org/w/api.php?'))
        self.assertTrue(calls[1].startswith('https://upload.wikimedia.org/wikipedia/commons/'))
        restored = hl.HouseLearner(self.tmp.name, get_json, get_image, 'Test')
        self.assertEqual(restored.snapshot()['samples'], 1)
        restored.learn_once()
        self.assertEqual(restored.snapshot()['samples'], 1)
        self.assertEqual(restored.snapshot()['status'], 'no_new_images')

    def test_no_unlicensed_or_untrusted_downloads(self):
        for data in (self.fixture('https://evil.example/'), self.fixture(author=''),
                     self.fixture(url='https://evil.example/image.png'), self.fixture('https://creativecommons.org/licenses/by-nc/4.0/')):
            received = []
            learner = hl.HouseLearner(self.tmp.name, lambda req, timeout: data, lambda req, timeout: received.append(req) or b'', 'Test')
            learner.learn_once()
            self.assertEqual(received, [])
            self.assertEqual(learner.snapshot()['samples'], 0)
        self.assertFalse(hl.good_thumb('https://upload.wikimedia.org.evil.example/wikipedia/commons/x'))
        self.assertFalse(hl.good_thumb('https://upload.wikimedia.org:444/wikipedia/commons/x'))

    def test_offline_error_and_untrusted_json_are_reported(self):
        def fail(req, timeout): raise URLError('offline')
        learner = hl.HouseLearner(self.tmp.name, fail, lambda req, timeout: b'', 'Test')
        learner.learn_once()
        self.assertEqual(learner.snapshot()['status'], 'unavailable')
        self.assertEqual(learner.snapshot()['samples'], 0)
        self.assertFalse(hl.valid_state({'version': 1, 'samples': 100}))
        learner = hl.HouseLearner(self.tmp.name, lambda req, timeout: {'error': {'code': 'bad-request'}}, lambda req, timeout: b'', 'Test')
        learner.learn_once()
        self.assertEqual(learner.snapshot()['status'], 'unavailable')
        self.assertEqual(hl.group_for_text('a small little house'), 'small')
        self.assertEqual(hl.group_for_text('بيت طويل'), 'tall')

    def test_invalid_image_storage_failure_and_missing_pillow(self):
        learner = hl.HouseLearner(self.tmp.name, lambda req, timeout: self.fixture(), lambda req, timeout: b'bad image', 'Test')
        learner.learn_once()
        self.assertEqual(learner.snapshot()['status'], 'unavailable')
        self.assertEqual(learner.snapshot()['cursor'], 1)  # bad image does not block future searches
        learner = hl.HouseLearner(os.path.join(self.tmp.name, 'missing'), lambda req, timeout: self.fixture(), lambda req, timeout: self.bytes.getvalue(), 'Test')
        learner.learn_once()
        self.assertEqual(learner.snapshot()['status'], 'unavailable')
        self.assertEqual(learner.snapshot()['samples'], 0)
        with patch.object(hl, 'Image', None):
            learner = hl.HouseLearner(self.tmp.name, lambda req, timeout: self.fail('no request'), lambda req, timeout: b'', 'Test')
            learner.learn_once()
            self.assertEqual(learner.snapshot()['status'], 'missing_pillow')

    def test_rolling_window_keeps_only_attributed_samples(self):
        i = 0
        def get_json(req, timeout):
            nonlocal i
            i += 1
            data = self.fixture()
            data['query']['pages'][0]['title'] = f'File:Small house {i}.png'
            return data
        with patch.object(hl, 'MAX_SOURCES', 2):
            learner = hl.HouseLearner(self.tmp.name, get_json, lambda req, timeout: self.bytes.getvalue(), 'Test')
            for _ in range(3): learner.learn_once()
            result = learner.snapshot()
            self.assertEqual(result['samples'], 2)
            self.assertEqual(result['profiles']['small']['count'], 2)
            self.assertEqual(len(result['sources']), 2)
            self.assertNotIn('1.png', result['sources'][0]['url'])
            self.assertTrue(hl.valid_state(learner.state))

    def test_background_runs_without_browser(self):
        complete = threading.Event()
        def get_json(req, timeout): complete.set(); return self.fixture()
        learner = hl.HouseLearner(self.tmp.name, get_json, lambda req, timeout: self.bytes.getvalue(), 'Test', interval=60)
        learner.start()
        self.assertTrue(complete.wait(2))
        learner.stop()
        for thread in threading.enumerate():
            if thread.name == 'house-image-learner': thread.join(timeout=2)
        self.assertEqual(learner.snapshot()['samples'], 1)

if __name__ == '__main__': unittest.main()
