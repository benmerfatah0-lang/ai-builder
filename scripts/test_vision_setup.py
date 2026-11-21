import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('vision_setup', Path(__file__).resolve().parents[1] / 'vision-setup.py')
vision = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vision)

def archive():
    data=io.BytesIO()
    with tarfile.open(fileobj=data,mode='w:gz') as tar:
        payload=b'test model'; info=tarfile.TarInfo('package/file');info.size=len(payload);tar.addfile(info,io.BytesIO(payload))
    return data.getvalue()

class VisionSetupTest(unittest.TestCase):
    def test_pinned_archive_and_file_are_verified_and_installed(self):
        with tempfile.TemporaryDirectory() as directory:
            blob=archive(); digest=hashlib.sha256(b'test model').hexdigest()
            source=[('https://example.invalid',hashlib.sha256(blob).hexdigest(),{'package/file':('scene.onnx',digest)})]
            with patch.object(vision,'OUT',Path(directory)),patch.object(vision,'SOURCES',source),patch.object(vision,'urlopen',return_value=io.BytesIO(blob)) as request:
                vision.install();self.assertEqual((Path(directory)/'scene.onnx').read_bytes(),b'test model')
                vision.install();self.assertEqual(request.call_count,1)
    def test_bad_hash_does_not_replace_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'scene.onnx';path.write_bytes(b'old')
            source=[('https://example.invalid','wrong',{'package/file':('scene.onnx','wrong')})]
            with patch.object(vision,'OUT',Path(directory)),patch.object(vision,'SOURCES',source),patch.object(vision,'urlopen',return_value=io.BytesIO(archive())):
                with self.assertRaisesRegex(ValueError,'checksum mismatch'):vision.install()
            self.assertEqual(path.read_bytes(),b'old')

if __name__=='__main__':unittest.main()
