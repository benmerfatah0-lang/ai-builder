import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import type { Transform } from './schema';

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function round(value: number, precision = 4): number {
  const factor = 10 ** precision;
  const rounded = Math.round(value * factor) / factor;
  // Normalise -0 so saved JSON and deep comparisons stay stable.
  return Object.is(rounded, -0) ? 0 : rounded;
}

export const IDENTITY_TRANSFORM: Transform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

export function identityTransform(): Transform {
  return {
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  };
}

/** Compose a local transform into a 4x4 matrix (XYZ Euler order, degrees). */
export function composeTransformMatrix(transform: Transform): Matrix4 {
  const quaternion = new Quaternion().setFromEuler(
    new Euler(
      transform.rotation[0] * DEG2RAD,
      transform.rotation[1] * DEG2RAD,
      transform.rotation[2] * DEG2RAD,
      'XYZ',
    ),
  );
  return new Matrix4().compose(
    new Vector3(transform.position[0], transform.position[1], transform.position[2]),
    quaternion,
    new Vector3(transform.scale[0], transform.scale[1], transform.scale[2]),
  );
}

/** Decompose a matrix back into a clamped WorldPlan transform. */
export function decomposeTransformMatrix(matrix: Matrix4): Transform {
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();
  matrix.decompose(position, quaternion, scale);

  const euler = new Euler().setFromQuaternion(quaternion, 'XYZ');
  return {
    position: [round(position.x), round(position.y), round(position.z)],
    rotation: [
      round(euler.x * RAD2DEG, 3),
      round(euler.y * RAD2DEG, 3),
      round(euler.z * RAD2DEG, 3),
    ],
    scale: [
      Math.max(0.05, round(scale.x)),
      Math.max(0.05, round(scale.y)),
      Math.max(0.05, round(scale.z)),
    ],
  };
}

/** Multiply local matrices from `order` left-to-right (parent first). */
export function multiplyTransforms(transforms: Transform[]): Matrix4 {
  const matrix = new Matrix4();
  for (const transform of transforms) {
    matrix.multiply(composeTransformMatrix(transform));
  }
  return matrix;
}

/**
 * Convert a world transform into the local space of `parentWorld`.
 * Used by reparenting and ungrouping so objects do not visually jump.
 */
export function transformRelativeTo(parentWorld: Matrix4, world: Transform): Transform {
  const local = parentWorld.clone().invert().multiply(composeTransformMatrix(world));
  return decomposeTransformMatrix(local);
}

export function approxEqualTransform(a: Transform, b: Transform, epsilon = 1e-3): boolean {
  const close = (left: number, right: number) => Math.abs(left - right) <= epsilon;
  return (
    a.position.every((value, index) => close(value, b.position[index] ?? 0)) &&
    a.rotation.every((value, index) => close(value, b.rotation[index] ?? 0)) &&
    a.scale.every((value, index) => close(value, b.scale[index] ?? 1))
  );
}
