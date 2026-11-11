import * as THREE from 'three';
import { base64ToBytes, type GeneratedMeshData } from '../world-plan/generatedMesh';

/** Decode the validated embedded mesh. Values are stored little-endian. */
export function buildGeneratedGeometry(mesh: GeneratedMeshData): THREE.BufferGeometry {
  const bytes = base64ToBytes(mesh.data);
  const view = new DataView(bytes.buffer);
  const positions = new Float32Array(mesh.vertices * 3);
  const indices = new Uint32Array(mesh.indices);
  for (let i=0;i<positions.length;i++) positions[i] = view.getFloat32(i*4,true);
  for (let i=0;i<indices.length;i++) indices[i] = view.getUint32(mesh.vertices*12+i*4,true);
  const colors = bytes.slice(mesh.vertices*12+mesh.indices*4);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions,3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors,3,true));
  geometry.setIndex(new THREE.BufferAttribute(indices,1));
  geometry.computeVertexNormals();
  return geometry;
}
