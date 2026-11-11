/** Compact, bounded triangle geometry embedded in a WorldPlan; no executable code or URLs. */
export const MAX_GENERATED_VERTICES = 120_000;
export const MAX_GENERATED_INDICES = 750_000;
export const MAX_GENERATED_DATA = 7_000_000; // base64 characters per project
export interface GeneratedMeshData { vertices: number; indices: number; data: string }

export function bytesToBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(text);
}
export function base64ToBytes(data: string): Uint8Array {
  const text = atob(data);
  const result = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) result[i] = text.charCodeAt(i);
  return result;
}
export function generatedMeshValid(mesh: GeneratedMeshData): boolean {
  try {
    const { vertices, indices, data } = mesh;
    if (!Number.isInteger(vertices) || vertices < 3 || vertices > MAX_GENERATED_VERTICES ||
        !Number.isInteger(indices) || indices < 3 || indices > MAX_GENERATED_INDICES || indices % 3 ||
        data.length > MAX_GENERATED_DATA || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) return false;
    const expected = vertices * 15 + indices * 4;
    if (data.length !== Math.ceil(expected / 3) * 4) return false;
    const bytes = base64ToBytes(data);
    if (bytes.length !== expected) return false;
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < vertices * 3; i++) {
      const n = view.getFloat32(i * 4, true);
      if (!Number.isFinite(n) || Math.abs(n) > 100) return false;
    }
    for (let i = 0; i < indices; i++) if (view.getUint32(vertices * 12 + i * 4, true) >= vertices) return false;
    return true;
  } catch { return false; }
}
