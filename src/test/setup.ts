import 'fake-indexeddb/auto';

/**
 * Node does not ship the DOM FileReader that Three.js's GLTFExporter uses to
 * assemble binary chunks. This shim mirrors the small subset of the browser
 * API the exporter relies on, so GLB output can be verified in unit tests.
 */
if (typeof globalThis.FileReader === 'undefined') {
  class TestFileReader {
    result: string | ArrayBuffer | null = null;
    onloadend: (() => void) | null = null;
    onerror: ((error: unknown) => void) | null = null;

    readAsArrayBuffer(blob: Blob): void {
      blob
        .arrayBuffer()
        .then((buffer) => {
          this.result = buffer;
          this.onloadend?.();
        })
        .catch((error: unknown) => {
          this.onerror?.(error);
        });
    }

    readAsDataURL(blob: Blob): void {
      blob
        .arrayBuffer()
        .then((buffer) => {
          const base64 = Buffer.from(buffer).toString('base64');
          this.result = `data:${blob.type};base64,${base64}`;
          this.onloadend?.();
        })
        .catch((error: unknown) => {
          this.onerror?.(error);
        });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).FileReader = TestFileReader;
}
