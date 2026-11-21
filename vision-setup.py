#!/usr/bin/env python3
"""Install optional, pinned local scene-vision files. No image or prompt is uploaded."""
import hashlib
import os
import tarfile
import tempfile
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'vision'
SOURCES = [
    ('https://codeload.github.com/kisakutanaka/SkySegmentation/tar.gz/4f1715a9517e065d2867a724b4dc6aad914f0aca',
     'bc962b6d9b4b436f3c6cab9d4623db54455f61e89295ff82a5b426f43b1a5e52', {
       'SkySegmentation-4f1715a9517e065d2867a724b4dc6aad914f0aca/models/pp_mobileseg_base_ade20k_512.onnx': ('scene.onnx','63c15451d3907472410de9417cabf2f121b62006d50b980fb2f774ceddaeec7a'),
     }),
    ('https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.20.1.tgz',
     '0a38facf0672dfaaeaf352e8a9f44533732b60b4af93b9dd507fe7c2d2be437b', {
       'package/dist/ort.wasm.min.js': ('ort.wasm.min.js','e66568724f8848e57cc2a56e4bea3a5b86ce3ff81b2da11eac8ed7ab02b27bd4'),
       'package/dist/ort-wasm-simd-threaded.mjs': ('ort-wasm-simd-threaded.mjs','745eb7c0ce6f18a6aa521971b2877babc7ffb27eecb58ab3bc6e5ef4692672e8'),
       'package/dist/ort-wasm-simd-threaded.wasm': ('ort-wasm-simd-threaded.wasm','207d02be4591c156b0a98f024f3d58005b5b04c92274d759fb390338c63559ea'),
     }),
]

def install():
    OUT.mkdir(exist_ok=True)
    for url, expected, wanted in SOURCES:
        if all((OUT/name).is_file() and hashlib.sha256((OUT/name).read_bytes()).hexdigest()==digest for name,digest in wanted.values()):
            continue
        print('Downloading', url, flush=True)
        with tempfile.TemporaryFile() as temp:
            h=hashlib.sha256(); total=0
            with urlopen(Request(url,headers={'User-Agent':'AIWorldBuilder/1.0'}),timeout=60) as response:
                while True:
                    chunk=response.read(1024*1024)
                    if not chunk: break
                    total+=len(chunk)
                    if total>50_000_000: raise ValueError('Archive exceeds size limit')
                    h.update(chunk);temp.write(chunk)
            if h.hexdigest()!=expected: raise ValueError('Archive checksum mismatch')
            temp.seek(0)
            with tarfile.open(fileobj=temp,mode='r:gz') as archive:
                for path,(name,digest) in wanted.items():
                    member=archive.getmember(path)
                    if not member.isfile() or member.size>30_000_000: raise ValueError('Invalid archive member')
                    source=archive.extractfile(member)
                    if source is None: raise ValueError('Missing archive member')
                    content=source.read(30_000_001)
                    if hashlib.sha256(content).hexdigest()!=digest: raise ValueError('File checksum mismatch')
                    target=OUT/name; tmp=OUT/(name+'.part')
                    try:
                        tmp.write_bytes(content);os.replace(tmp,target)
                    finally:
                        tmp.unlink(missing_ok=True)
    print('Local vision installed in', OUT, flush=True)

if __name__=='__main__':
    try: install()
    except Exception as exc:
        print('Vision installation failed:',exc,flush=True)
        raise SystemExit(1)
