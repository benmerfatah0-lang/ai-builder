"""Local learning tests. Wikipedia is mocked; no external traffic."""
import json
import os
import tempfile
import threading
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import unittest
from urllib.error import URLError
from unittest.mock import patch
from wiki_learner import WikiLearner, initial_state, validate_state, terms, MAX_SOURCES


class WikiLearningTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def make(self, fetch):
        return WikiLearner(self.tmp.name, fetch, 'test-agent', interval=0.05)

    def test_trains_on_fixed_topics_and_persists_without_repeating_articles(self):
        calls = []
        def fetch(req, timeout):
            calls.append(req.full_url)
            return {'pages': [{'title': 'Desert', 'key': 'Desert', 'excerpt': 'Arid sand dunes and an oasis'},
                              {'title': 'Not related', 'key': 'Secret', 'excerpt': 'arid'},
                              {'title': 'Desert invalid', 'key': '', 'excerpt': 'sand'}]}
        learner = self.make(fetch)
        learner.learn_once()
        self.assertTrue(calls[0].startswith('https://en.wikipedia.org/w/rest.php/v1/search/page?'))
        result = learner.snapshot()
        self.assertEqual(result['classes']['desert']['docs'], 1)
        self.assertEqual(result['classes']['desert']['tokens']['arid'], 1)
        self.assertEqual(result['sources'], [{'label': 'desert', 'title': 'Desert', 'url': 'https://en.wikipedia.org/wiki/Desert'}])
        self.assertTrue(validate_state(learner.state))
        resumed = self.make(fetch)
        self.assertEqual(resumed.state, learner.state)
        resumed.learn_once()  # next fixed query sees the same URL: do not relearn it
        self.assertEqual(resumed.snapshot()['classes']['desert']['docs'], 1)
        self.assertEqual(resumed.snapshot()['status'], 'no_new_articles')

    def test_failure_is_reported_and_invalid_storage_is_not_trusted(self):
        with open(os.path.join(self.tmp.name, 'wiki-map-learning.json'), 'w') as f:
            json.dump({'version': 1, 'classes': {'evil': {}}, 'sources': []}, f)
        def fail(req, timeout): raise URLError('offline')
        learner = self.make(fail)
        self.assertEqual(learner.state, initial_state())
        learner.learn_once()
        self.assertEqual(learner.snapshot()['status'], 'unavailable')
        self.assertEqual(learner.snapshot()['cursor'], 0)
        self.assertIn('واحات', terms('الوَاحَات'))

    def test_learning_runs_without_a_browser_and_can_stop(self):
        called = threading.Event()
        def fetch(req, timeout):
            called.set()
            return {'pages': [{'title': 'Desert', 'key': 'Desert', 'excerpt': 'desert sand'}]}
        learner = self.make(fetch)
        learner.start()
        self.assertTrue(called.wait(2))
        learner.stop()
        # Completion may follow signalling the fake request; wait for a persisted result.
        for thread in threading.enumerate():
            if thread.name == 'wiki-map-learner': thread.join(timeout=2)
        self.assertEqual(learner.snapshot()['classes']['desert']['docs'], 1)

    @patch('wiki_learner.MAX_SOURCES', 2)
    def test_training_is_bounded_and_evicts_old_counts(self):
        def fetch(req, timeout):
            return {'pages': [{'title': 'Desert one', 'key': 'Desert_1', 'excerpt': 'arid'},
                              {'title': 'Desert two', 'key': 'Desert_2', 'excerpt': 'sand'},
                              {'title': 'Desert three', 'key': 'Desert_3', 'excerpt': 'oasis'}]}
        learner = self.make(fetch)
        learner.learn_once()
        self.assertEqual(learner.state['classes']['desert']['docs'], 2)
        self.assertEqual(len(learner.state['sources']), 2)
        self.assertNotIn('arid', learner.state['classes']['desert']['tokens'])
        self.assertTrue(validate_state(learner.state))

    def test_state_validation_rejects_unknown_features_and_sources(self):
        state = initial_state()
        state['classes']['desert']['docs'] = 1
        state['classes']['desert']['tokens'] = {'untrusted': 1}
        state['sources'] = [{'label': 'desert', 'title': 'X', 'url': 'https://evil.example/wiki/X', 'words': ['untrusted']}]
        self.assertFalse(validate_state(state))
        self.assertEqual(MAX_SOURCES, 200)

if __name__ == '__main__':
    unittest.main()
