import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  MeshBuilder, boundsOf, dataFromGeometry, geometryFromData, isSane, signedArea, triangulatePolygon,
  type MeshData,
} from './mesh';
import { arch, box, cylinder, extrude, lathe, loft, plane, prism, sphere, sweep, torus } from './primitives';
import {
  QUALITY_TRIANGLES, banner, barrel, blade, bone, boulder, branch, chain, corbel, crag,
  crenellations, crystalCluster, dentils, displace, door, dressedBlock, feather, fracture,
  framedPanel, gear, helix, hoopBand, leafCluster, palisade, planks, planRepeatedUnits, post,
  ridgeCap, rivetRow, rockCluster, rope, roofPanel, ruinTop, spikeRow, stairs, stoneWall,
  stringCourse, trunk, tuft, vessel, wattleFence, wheel, wing, windowUnit,
} from './detail';
import {
  arcade, balcony, chimney, conicalRoof, cornice, dome, flatRoof, floorSlab, gableRoof, hipRoof,
  leanToRoof, machicolation, parapetRun, porch, timberFrame, towerShaft, wallFace,
} from './components/shell';
import {
  bamboo, bush, cactus, deadTree, fallenLog, fern, fernFrond, flower, flowerCluster, grassTuft,
  hedge, leafLitter, mushroom, mushroomCluster, reed, treeStump,
} from './components/nature';
import { getModelTexture, cachedModelTextures, type ModelTextureKind } from './textures';
import { SURFACES, getModelMaterial, materialsFor, pickSurface, PALETTES, surfaceTexel } from './materials';
import { REFERENCE, dimensionsOf, normalize, scaleWarnings, seatOnGround, referenceSize } from './scale';

/* ------------------------------------------------------------- geometry QA */

function vertexAt(data: MeshData, corner: number): [number, number, number] {
  const index = data.indices[corner]!;
  return [data.positions[index * 3]!, data.positions[index * 3 + 1]!, data.positions[index * 3 + 2]!];
}

/**
 * Signed volume of the triangle soup.
 *
 * For a closed solid this is exactly the enclosed volume, so its sign says which
 * way the faces wind: positive means the outside is outside. That makes it a real
 * check on every primitive rather than a guess about a few triangles, and it
 * catches a mirrored part, which quietly inverts winding without moving a vertex.
 */
function signedVolume(data: MeshData): number {
  let total = 0;
  for (let corner = 0; corner + 2 < data.indices.length; corner += 3) {
    const a = vertexAt(data, corner);
    const b = vertexAt(data, corner + 1);
    const c = vertexAt(data, corner + 2);
    total += (
      a[0] * (b[1] * c[2] - b[2] * c[1])
      - a[1] * (b[0] * c[2] - b[2] * c[0])
      + a[2] * (b[0] * c[1] - b[1] * c[0])
    ) / 6;
  }
  return total;
}

/**
 * Faces laid exactly over another face with the same winding: a doubled skin.
 *
 * Two triangles sharing a boundary edge is normal in an assembly — a stair tread
 * meets the soffit of the step above along a line, and those two faces wind the
 * same way along it without being wrong. What is never normal is two faces in the
 * same plane with the same normal on the same edge: that is a duplicated cap or a
 * folded quad, and it z-fights on screen. So the normal has to agree before an
 * edge counts as a fault.
 */
function doubleFaces(data: MeshData, tolerance = 1e-4): number {
  const key = (corner: number): string => {
    const point = vertexAt(data, corner);
    return point.map((value) => Math.round(value / tolerance)).join(',');
  };
  const faceNormal = (triangle: number): THREE.Vector3 => {
    const a = vertexAt(data, triangle * 3);
    const b = vertexAt(data, triangle * 3 + 1);
    const c = vertexAt(data, triangle * 3 + 2);
    return new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2])
      .cross(new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]))
      .normalize();
  };
  const owners = new Map<string, number[]>();
  for (let triangle = 0; triangle * 3 + 2 < data.indices.length; triangle += 1) {
    const corners = [key(triangle * 3), key(triangle * 3 + 1), key(triangle * 3 + 2)];
    for (let edge = 0; edge < 3; edge += 1) {
      const from = corners[edge]!;
      const to = corners[(edge + 1) % 3]!;
      if (from === to) continue;
      const directed = `${from}|${to}`;
      const list = owners.get(directed) ?? [];
      list.push(triangle);
      owners.set(directed, list);
    }
  }
  let doubled = 0;
  for (const list of owners.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        if (faceNormal(list[i]!).dot(faceNormal(list[j]!)) > 0.99) doubled += 1;
      }
    }
  }
  return doubled;
}

/** Largest distance of any vertex from the outside of the requested bounds. */
function outsideBounds(data: MeshData, min: [number, number, number], max: [number, number, number]): number {
  let worst = 0;
  for (let index = 0; index < data.positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = data.positions[index + axis]!;
      worst = Math.max(worst, min[axis]! - value, value - max[axis]!);
    }
  }
  return worst;
}

/**
 * Where a ray crosses the surface, by distance along it.
 *
 * Sampling vertices cannot answer "is this doorway actually open" — a wall painted
 * with a dark rectangle has no vertices in the opening either, and a decorative
 * stone a metre away has one. Shooting a ray through the model asks the question
 * the viewer asks: is there surface here or not.
 */
function rayHits(data: MeshData, origin: [number, number, number], direction: [number, number, number], maxDistance: number): number[] {
  const o = new THREE.Vector3(...origin);
  const d = new THREE.Vector3(...direction).normalize();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const edge1 = new THREE.Vector3();
  const edge2 = new THREE.Vector3();
  const cross = new THREE.Vector3();
  const toOrigin = new THREE.Vector3();
  const along = new THREE.Vector3();
  const hits: number[] = [];
  for (let triangle = 0; triangle * 3 + 2 < data.indices.length; triangle += 1) {
    a.set(...vertexAt(data, triangle * 3));
    b.set(...vertexAt(data, triangle * 3 + 1));
    c.set(...vertexAt(data, triangle * 3 + 2));
    edge1.subVectors(b, a);
    edge2.subVectors(c, a);
    cross.crossVectors(d, edge2);
    const determinant = edge1.dot(cross);
    if (Math.abs(determinant) < 1e-10) continue;
    const inverse = 1 / determinant;
    toOrigin.subVectors(o, a);
    const u = inverse * toOrigin.dot(cross);
    if (u < -1e-6 || u > 1 + 1e-6) continue;
    along.crossVectors(toOrigin, edge1);
    const v = inverse * d.dot(along);
    if (v < -1e-6 || u + v > 1 + 1e-6) continue;
    const distance = inverse * edge2.dot(along);
    if (distance > 1e-4 && distance <= maxDistance) hits.push(distance);
  }
  return hits.sort((first, second) => first - second);
}

function report(builder: MeshBuilder): { data: MeshData; tris: number; bounds: ReturnType<typeof boundsOf> } {
  const data = builder.build();
  return { data, tris: data.indices.length / 3, bounds: boundsOf(data) };
}

describe('mesh builder', () => {
  it('winds a quad so its face normal points at the viewer', () => {
    const builder = new MeshBuilder();
    const a = builder.vertex([0, 0, 0], [0, 0], [0, 0, 1]);
    const b = builder.vertex([1, 0, 0], [1, 0], [0, 0, 1]);
    const c = builder.vertex([1, 1, 0], [1, 1], [0, 0, 1]);
    const d = builder.vertex([0, 1, 0], [0, 1], [0, 0, 1]);
    builder.quad(a, b, c, d);
    builder.computeNormals();
    const data = builder.build();
    expect(data.indices).toHaveLength(6);
    // Counter-clockwise in XY seen from +Z: the normal must come out at us.
    expect(data.normals[2]).toBeCloseTo(1, 6);
    // A single flat quad encloses nothing, so its signed volume is zero; the
    // sign only becomes meaningful once the surface closes.
    expect(Math.abs(signedVolume(data))).toBeLessThan(1e-9);
  });

  it('drops degenerate triangles instead of emitting zero-area faces', () => {
    const builder = new MeshBuilder();
    const a = builder.vertex([0, 0, 0]);
    const b = builder.vertex([1, 0, 0]);
    builder.triangle(a, b, a);
    expect(builder.triangleCount).toBe(0);
    expect(builder.build().indices).toHaveLength(0);
  });

  it('mirrors geometry and takes the winding with it, so the solid stays outside out', () => {
    const solid = box(1, 2, 1).translate(3, 0, 0);
    expect(signedVolume(solid.build())).toBeCloseTo(2, 4);
    solid.mirror('x');
    const data = solid.build();
    // A reflection inverts handedness. `mirror` reverses the winding to
    // compensate, so the volume stays positive; a builder that mirrored without
    // flipping would leave the object inside out and light it from within.
    expect(signedVolume(data)).toBeCloseTo(2, 4);
    expect(doubleFaces(data)).toBe(0);
    expect(boundsOf(data).max[0]).toBeCloseTo(-2.5, 5);
    expect(boundsOf(data).min[0]).toBeCloseTo(-3.5, 5);
  });

  it('leaves a negative scale inverted, which is why mirror exists', () => {
    const builder = box(1, 1, 1);
    builder.scale(-1, 1, 1);
    // diag(-1, 1, 1) has determinant -1: the faces now wind inward. This is the
    // trap `mirror` avoids, and the reason nothing in the kernel scales by -1.
    expect(signedVolume(builder.build())).toBeLessThan(0);
  });

  it('computes area-weighted normals that agree with the face winding', () => {
    const builder = new MeshBuilder();
    const a = builder.vertex([0, 0, 0]);
    const b = builder.vertex([2, 0, 0]);
    const c = builder.vertex([0, 3, 0]);
    builder.triangle(a, b, c);
    builder.computeNormals();
    const data = builder.build();
    expect(data.normals[2]).toBeCloseTo(1, 6);
    expect(data.normals[0]).toBeCloseTo(0, 6);
  });

  it('flat-shades by giving every triangle its own face normal', () => {
    const builder = sphere(1, { widthSegments: 10, heightSegments: 7 });
    builder.flatShade();
    const data = builder.build();
    for (let corner = 0; corner + 2 < data.indices.length; corner += 3) {
      const first = vertexAt(data, corner);
      const normalIndex = data.indices[corner]! * 3;
      const expected = new THREE.Vector3(...first).normalize();
      const actual = new THREE.Vector3(data.normals[normalIndex]!, data.normals[normalIndex + 1]!, data.normals[normalIndex + 2]!);
      // On a sphere centred at the origin the face normal and the vertex
      // direction must agree to within the faceting error.
      expect(actual.dot(expected)).toBeGreaterThan(0.9);
    }
  });

  it('welds coincident vertices that share UVs and keeps those that do not', () => {
    // Two triangles meeting along a seam, each carrying its own copy of the seam
    // vertices — the shape every generator produces before welding.
    const builder = new MeshBuilder();
    const a = builder.vertex([-1, 0, 0], [0, 0]);
    const seamTop = builder.vertex([0, 0, 0], [1, 0]);
    const seamBottom = builder.vertex([0, 0, 0], [0, 0]);
    const b = builder.vertex([1, 0, 0], [1, 0]);
    const apex = builder.vertex([0, 1, 0], [0.5, 1]);
    const apexCopy = builder.vertex([0, 1, 0], [0.5, 1]);
    builder.triangle(a, seamBottom, apex);
    builder.triangle(seamTop, b, apexCopy);
    expect(builder.build().positions.length / 3).toBe(6);
    builder.weld(1e-6);
    const data = builder.build();
    // The seam vertices share a position but not UVs, so both must survive; the
    // two apex copies are identical in position and UV, so they become one.
    expect(data.positions.length / 3).toBe(5);
    expect(isSane(data)).toBe(true);
    expect(data.indices).toHaveLength(6);
  });

  it('derives draw groups from material ids so one surface is one draw call', () => {
    const wall = stoneWall({ width: 4, height: 3, thickness: 0.4, style: 'ashlar', seed: 5 });
    const builder = new MeshBuilder();
    builder.add(wall, undefined, 'stone-dressed');
    builder.add(box(1, 1, 1), undefined, 'wood-oak');
    const data = builder.build();
    expect(data.materials).toEqual(['stone-dressed', 'wood-oak']);
    expect(data.groups).toHaveLength(2);
    const covered = data.groups.reduce((total, group) => total + group.count, 0);
    expect(covered).toBe(data.indices.length);
  });

  it('round-trips through THREE geometry without losing groups or uvs', () => {
    const builder = new MeshBuilder();
    builder.add(box(1, 2, 3), undefined, 'a');
    builder.add(cylinder(0.5, 0.5, 1), undefined, 'b');
    const data = builder.build();
    const geometry = geometryFromData(data);
    expect(geometry.attributes.position).toBeDefined();
    expect(geometry.groups).toHaveLength(2);
    const restored = dataFromGeometry(geometry, data.materials);
    // The round trip may re-index, but it must not change the surface: same
    // triangle count, same bounds, same UVs per triangle corner.
    expect(restored.indices.length).toBe(data.indices.length);
    expect(restored.materials).toEqual(data.materials);
    const before = boundsOf(data);
    const after = boundsOf(restored);
    expect(after.size[0]).toBeCloseTo(before.size[0], 5);
    expect(after.size[1]).toBeCloseTo(before.size[1], 5);
    expect(after.size[2]).toBeCloseTo(before.size[2], 5);
    expect(restored.uvs.length / 2).toBe(restored.positions.length / 3);
  });

  it('triangulates a concave polygon and reports its signed area', () => {
    const l: [number, number][] = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 3], [0, 3]];
    expect(signedArea(l)).toBeCloseTo(4, 6);
    const indices = triangulatePolygon(l);
    expect(indices.length / 3).toBe(l.length - 2);
    let area = 0;
    for (let index = 0; index + 2 < indices.length; index += 3) {
      const a = l[indices[index]!]!;
      const b = l[indices[index + 1]!]!;
      const c = l[indices[index + 2]!]!;
      area += signedArea([a, b, c]);
    }
    expect(Math.abs(area)).toBeCloseTo(4, 5);
  });
});

describe('primitives', () => {
  const solids: { name: string; build: () => MeshBuilder; volume: number; tolerance: number }[] = [
    { name: 'box', build: () => box(1.5, 0.75, 2), volume: 1.5 * 0.75 * 2, tolerance: 1e-6 },
    { name: 'bevelled box', build: () => box(1.5, 0.75, 2, { bevel: 0.06, bevelSegments: 2 }), volume: 1.5 * 0.75 * 2, tolerance: 0.06 },
    { name: 'cylinder', build: () => cylinder(0.8, 0.8, 2, { radialSegments: 24 }), volume: Math.PI * 0.64 * 2, tolerance: 0.02 },
    { name: 'sphere', build: () => sphere(1, { widthSegments: 24, heightSegments: 16 }), volume: (4 / 3) * Math.PI, tolerance: 0.05 },
    { name: 'torus', build: () => torus(0.6, 0.1, { radialSegments: 12, tubularSegments: 24 }), volume: 2 * Math.PI * Math.PI * 0.6 * 0.01, tolerance: 0.004 },
    { name: 'prism', build: () => prism({ sides: 6, radius: 1, height: 2 }), volume: (3 * Math.sqrt(3) / 2) * 2, tolerance: 0.01 },
    { name: 'pyramid', build: () => prism({ sides: 4, radius: 1, height: 3, topScale: 0 }), volume: (2 / 3) * 3, tolerance: 0.01 },
    { name: 'extrude', build: () => extrude([[0, 0], [2, 0], [2, 1], [0, 1]], { depth: 1.5 }), volume: 3, tolerance: 1e-6 },
    { name: 'lathe', build: () => lathe([[0, 0], [0.5, 0], [0.5, 1], [0, 1]], { segments: 24, caps: true }), volume: Math.PI * 0.25, tolerance: 0.01 },
    {
      name: 'sweep',
      build: () => sweep([[0, 0, 0], [0, 2, 0]], { section: () => [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]], caps: true }),
      volume: 2,
      tolerance: 0.02,
    },
    {
      name: 'loft',
      // A square frustum from 2×2 to 1×1 over a height of 2.
      build: () => loft([
        { position: [0, 0, 0], profile: [[-1, -1], [1, -1], [1, 1], [-1, 1]] },
        { position: [0, 2, 0], profile: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] },
      ], { caps: true }),
      volume: (2 / 3) * (4 + 1 + 2),
      tolerance: 0.05,
    },
  ];

  it.each(solids)('encloses the right volume with outward winding: $name', ({ build, volume, tolerance }) => {
    const data = build().build();
    expect(isSane(data)).toBe(true);
    expect(doubleFaces(data)).toBe(0);
    const measured = signedVolume(data);
    expect(measured).toBeGreaterThan(0);
    expect(Math.abs(measured - volume)).toBeLessThan(Math.max(tolerance, volume * 0.06));
  });

  it('places a box, cylinder, sphere and torus where the caller expects them', () => {
    const cube = report(box(2, 1.5, 3).translate(1, 2, 3));
    expect(cube.bounds.min).toEqual([0, 1.25, 1.5]);
    expect(cube.bounds.max).toEqual([2, 2.75, 4.5]);

    const column = report(cylinder(0.8, 1, 2));
    expect(column.bounds.min[0]).toBeCloseTo(-1, 5);
    expect(column.bounds.max[0]).toBeCloseTo(1, 5);
    expect(column.bounds.min[1]).toBeCloseTo(-1, 5);
    expect(column.bounds.max[1]).toBeCloseTo(1, 5);

    const ball = report(sphere(1, { radii: [1, 0.6, 1] }));
    expect(ball.bounds.max[1]).toBeCloseTo(0.6, 4);

    // phi runs from the north pole, so half of it is the upper hemisphere.
    const domeShape = report(sphere(1, { phiLength: Math.PI / 2 }));
    expect(domeShape.bounds.min[1]).toBeCloseTo(0, 5);
    expect(domeShape.bounds.max[1]).toBeCloseTo(1, 5);

    const ring = report(torus(0.6, 0.1));
    // A torus lies in the XZ plane by default, so it is flat along Y.
    expect(ring.bounds.max[0]).toBeCloseTo(0.7, 3);
    // A ten-sided tube does not quite reach its own radius.
    expect(ring.bounds.max[1]).toBeGreaterThan(0.09);
    expect(ring.bounds.max[1]).toBeLessThan(0.1);
    expect(ring.bounds.max[2]).toBeCloseTo(0.7, 3);
  });

  it('builds an arc cylinder only over the requested sweep', () => {
    // The arc starts at +X and sweeps toward +Z, so a half cylinder is the
    // barrel-tile shell a Mediterranean roof needs: open toward -Z.
    const half = report(cylinder(1, 1, 1, { radialSegments: 16, arc: Math.PI }));
    expect(half.bounds.min[2]).toBeGreaterThan(-1e-6);
    expect(half.bounds.max[2]).toBeCloseTo(1, 4);
    expect(half.bounds.max[0]).toBeCloseTo(1, 4);
    expect(half.bounds.min[0]).toBeCloseTo(-1, 4);
    expect(signedVolume(half.data)).toBeGreaterThan(0);
  });

  it('carries a lathe profile round the axis without a seam gap', () => {
    const data = lathe([[0, 0], [0.6, 0], [0.62, 0.5], [0.2, 1.1], [0, 1.1]], { segments: 20, caps: true }).build();
    const bounds = boundsOf(data);
    expect(bounds.max[0]).toBeCloseTo(0.62, 4);
    expect(bounds.max[1]).toBeCloseTo(1.1, 4);
    expect(doubleFaces(data)).toBe(0);
    expect(signedVolume(data)).toBeGreaterThan(0);
  });

  it('lays a plane in XZ or XY and displaces it by the height field', () => {
    const ground = report(plane(4, 6, { widthSegments: 4, heightSegments: 3, height: (x, z) => Math.sin(x) * 0.1 + z * 0 }));
    expect(ground.bounds.max[1]).toBeLessThan(0.11);
    expect(ground.bounds.max[2]).toBeCloseTo(3, 5);
    const sheet = report(plane(4, 6, { orientation: 'xy' }));
    expect(sheet.bounds.max[1]).toBeCloseTo(3, 5);
    expect(sheet.bounds.max[2]).toBeCloseTo(0, 5);
  });

  it('builds arches whose crown reaches the requested rise', () => {
    for (const style of ['round', 'pointed', 'segmental', 'flat'] as const) {
      const data = arch({ span: 2.4, rise: 1.6, thickness: 0.3, depth: 0.5, style, voussoirs: style !== 'flat', segments: 20 }).build();
      expect(isSane(data)).toBe(true);
      expect(doubleFaces(data)).toBe(0);
      const bounds = boundsOf(data);
      // `span` is the opening. A curved ring's outer face is the span plus the
      // full thickness of the voussoirs; a flat lintel is just the opening.
      const outer = 1.2 + (style === 'flat' ? 0 : 0.3);
      expect(bounds.min[0]).toBeCloseTo(-outer, 2);
      expect(bounds.max[0]).toBeCloseTo(outer, 2);
      // A pointed arch's crown is the apex of two arcs, so it must be the tallest.
      expect(bounds.max[1]).toBeGreaterThan(style === 'pointed' ? 1.5 : 1.2);
      expect(signedVolume(data)).toBeGreaterThan(0);
    }
  });

  it('keeps sweep sections perpendicular to a curved spine', () => {
    const spine: [number, number, number][] = [];
    for (let index = 0; index <= 8; index += 1) {
      const t = index / 8;
      spine.push([Math.sin(t * Math.PI) * 1.2, t * 2, 0]);
    }
    const data = sweep(spine, { section: () => [[-0.2, -0.2], [0.2, -0.2], [0.2, 0.2], [-0.2, 0.2]], caps: true, resample: 12 }).build();
    expect(isSane(data)).toBe(true);
    expect(doubleFaces(data)).toBe(0);
    expect(signedVolume(data)).toBeGreaterThan(0);
    expect(boundsOf(data).max[1]).toBeGreaterThan(1.9);
  });
});

describe('detail generators', () => {
  const cases: { name: string; build: () => MeshBuilder; maxTriangles: number }[] = [
    { name: 'boulder', build: () => boulder({ radius: 0.9, seed: 1 }), maxTriangles: 400 },
    { name: 'rockCluster', build: () => rockCluster({ radius: 1.4, seed: 2 }), maxTriangles: 1600 },
    { name: 'crag', build: () => crag({ height: 4, radius: 1.1, seed: 3 }), maxTriangles: 400 },
    { name: 'fracture', build: () => fracture(box(2, 2, 2), { amplitude: 0.25, frequency: 2, seed: 3 }), maxTriangles: 400 },
    { name: 'ashlar wall', build: () => stoneWall({ width: 6, height: 3, thickness: 0.5, style: 'ashlar', seed: 4 }), maxTriangles: QUALITY_TRIANGLES.medium! },
    { name: 'rubble wall', build: () => stoneWall({ width: 6, height: 3, thickness: 0.8, style: 'rubble', seed: 5 }), maxTriangles: QUALITY_TRIANGLES.medium! },
    { name: 'brick wall', build: () => stoneWall({ width: 4, height: 2.6, thickness: 0.45, style: 'brick', seed: 6 }), maxTriangles: QUALITY_TRIANGLES.medium! },
    { name: 'ruined wall', build: () => stoneWall({ width: 6, height: 3, thickness: 0.5, style: 'ashlar', ruin: 0.4, seed: 7 }), maxTriangles: QUALITY_TRIANGLES.medium! },
    { name: 'ruin top', build: () => ruinTop(6, 3, 0.5, 0.6, 8, 900), maxTriangles: 900 },
    { name: 'dressed block', build: () => dressedBlock({ width: 0.9, height: 0.45, depth: 0.5 }), maxTriangles: 200 },
    { name: 'planking', build: () => planks({ width: 1.6, height: 2, thickness: 0.09, count: 7 }), maxTriangles: 900 },
    { name: 'framed panel', build: () => framedPanel({ width: 0.9, height: 1.8, thickness: 0.06 }), maxTriangles: 900 },
    { name: 'crenellations', build: () => crenellations({ length: 10, height: 0.7, thickness: 0.45 }), maxTriangles: 900 },
    { name: 'dentils', build: () => dentils({ length: 6, unit: 0.17, height: 0.12, depth: 0.14 }), maxTriangles: 900 },
    { name: 'string course', build: () => stringCourse({ length: 8 }), maxTriangles: 400 },
    { name: 'pan roof', build: () => roofPanel({ width: 8, slopeLength: 5, style: 'pan' }), maxTriangles: 1200 },
    { name: 'shingle roof', build: () => roofPanel({ width: 8, slopeLength: 5, style: 'shingle' }), maxTriangles: 1200 },
    { name: 'slate roof', build: () => roofPanel({ width: 8, slopeLength: 5, style: 'slate' }), maxTriangles: 1200 },
    { name: 'thatch roof', build: () => roofPanel({ width: 8, slopeLength: 5, style: 'thatch' }), maxTriangles: 1400 },
    { name: 'ridge cap', build: () => ridgeCap({ length: 8, radius: 0.13 }), maxTriangles: 700 },
    { name: 'plank door', build: () => door({ width: 0.95, height: 2.1, style: 'plank' }), maxTriangles: 1200 },
    { name: 'arched door', build: () => door({ width: 1.2, height: 2, style: 'arched' }), maxTriangles: 1200 },
    { name: 'iron door', build: () => door({ width: 1.6, height: 2.4, style: 'iron' }), maxTriangles: 1600 },
    { name: 'mullion window', build: () => windowUnit({ width: 1.2, height: 1.5, depth: 0.3, style: 'mullion' }), maxTriangles: 1200 },
    { name: 'lattice window', build: () => windowUnit({ width: 1.1, height: 1.4, depth: 0.22, style: 'lattice' }), maxTriangles: 1400 },
    { name: 'shutter', build: () => windowUnit({ width: 1.4, height: 1.3, depth: 0.4, style: 'shutter' }), maxTriangles: 1400 },
    { name: 'stairs', build: () => stairs({ steps: 11, rise: 0.2, tread: 0.28, width: 1.5, sides: 'wall' }), maxTriangles: 1400 },
    { name: 'spiral stairs', build: () => stairs({ steps: 16, rise: 0.18, width: 1, spiral: { radius: 1.3, turn: 0.45 } }), maxTriangles: 2400 },
    { name: 'hoop band', build: () => hoopBand({ radius: 0.32, tube: 0.02, width: 0.05 }), maxTriangles: 400 },
    { name: 'rivet row', build: () => rivetRow({ length: 1.1, radius: 0.02 }), maxTriangles: 600 },
    { name: 'rope', build: () => rope({ path: [[-0.5, 0, 0], [0, -0.3, 0], [0.5, 0, 0]], radius: 0.03 }), maxTriangles: 600 },
    { name: 'chain', build: () => chain({ from: [-1, 1, 0], to: [1, 1, 0], link: 0.14 }), maxTriangles: 1600 },
    { name: 'blade', build: () => blade({ length: 0.2, width: 0.05, camber: 0.015 }), maxTriangles: 200 },
    { name: 'leaf cluster', build: () => leafCluster({ radius: 1.6, leaves: 12, seed: 9 }), maxTriangles: 1200 },
    { name: 'feather', build: () => feather({ length: 0.4, width: 0.12 }), maxTriangles: 500 },
    // A wing is six separate feathers, each with its own barbs: expensive, but
    // it is the difference between a bird and a kite, and it fits one asset.
    { name: 'wing', build: () => wing({ span: 0.5, chord: 0.28 }), maxTriangles: 1800 },
    { name: 'trunk', build: () => trunk({ height: 6, radiusBottom: 0.55, seed: 10 }), maxTriangles: 1000 },
    { name: 'branch', build: () => branch({ length: 2.5, radiusBase: 0.12, seed: 11 }), maxTriangles: 1600 },
    { name: 'gear', build: () => gear({ radius: 0.7, teeth: 14, thickness: 0.12 }), maxTriangles: 2000 },
    { name: 'wheel', build: () => wheel({ radius: 0.7, width: 0.16 }), maxTriangles: 2000 },
    { name: 'helix', build: () => helix({ radius: 0.2, pitch: 0.13, turns: 3 }), maxTriangles: 1400 },
    { name: 'barrel', build: () => barrel({ radius: 0.35, height: 0.95 }), maxTriangles: 1400 },
    { name: 'vessel', build: () => vessel({ radius: 0.3, height: 0.9, style: 'amphora' }), maxTriangles: 1400 },
    { name: 'spike row', build: () => spikeRow({ length: 1.8, height: 0.5, count: 6 }), maxTriangles: 400 },
    { name: 'palisade', build: () => palisade({ length: 6, height: 2.9, seed: 12 }), maxTriangles: QUALITY_TRIANGLES.medium! },
    { name: 'wattle fence', build: () => wattleFence({ length: 5, height: 1.45 }), maxTriangles: 1400 },
    { name: 'banner', build: () => banner({ width: 1.2, height: 2 }), maxTriangles: 1200 },
    { name: 'tuft', build: () => tuft({ height: 0.4, blades: 9 }), maxTriangles: 400 },
    { name: 'crystal cluster', build: () => crystalCluster({ radius: 0.6, shards: 6, seed: 13 }), maxTriangles: 1000 },
    { name: 'bone', build: () => bone({ length: 0.42, radius: 0.045 }), maxTriangles: 700 },
    { name: 'post', build: () => post({ height: 2.2, radius: 0.12 }), maxTriangles: 200 },
    { name: 'corbel', build: () => corbel({ depth: 0.5, width: 0.32, height: 0.42 }), maxTriangles: 200 },
  ];

  it.each(cases)('builds $name within budget, sane and unbroken', ({ build, maxTriangles }) => {
    const data = build().build();
    expect(isSane(data)).toBe(true);
    expect(doubleFaces(data)).toBe(0);
    expect(data.indices.length / 3).toBeGreaterThan(0);
    expect(data.indices.length / 3).toBeLessThanOrEqual(maxTriangles);
  });

  it('covers the whole wall even when the budget cannot model every stone', () => {
    // The rule that matters: a wall that runs out of budget drops representation
    // — chamfered stones become plain, plain becomes a textured panel — but it
    // never stops halfway along or halfway up. Truncating left a 6 m wall
    // standing 1.26 m tall, which is not a cheaper wall, it is a different one.
    for (const budget of [300, 700, 1600, 6000]) {
      const data = stoneWall({ width: 6, height: 3, thickness: 0.5, style: 'rubble', seed: 5, budget }).build();
      const bounds = boundsOf(data);
      // Rubble stones project past the nominal face, so the length is checked as
      // a range rather than to the millimetre; the height must be exact.
      expect(bounds.size[0]).toBeGreaterThan(5.9);
      expect(bounds.size[0]).toBeLessThan(6.6);
      // The courses divide the wall exactly, so the top line is where the next
      // floor will sit: rough stones may stand a little proud, never short.
      expect(bounds.size[1]).toBeGreaterThan(2.9);
      expect(bounds.size[1]).toBeLessThan(3.08);
      expect(bounds.min[1]).toBeCloseTo(0, 1);
      expect(bounds.max[1]).toBeGreaterThan(2.95);
      expect(bounds.max[1]).toBeLessThan(3.05);
      // Rubble stones settle askew, so the wall may stand a little proud — but
      // it must not sink below the ground line it was built on.
      expect(bounds.min[1]).toBeGreaterThan(-0.03);
    }
    const cheap = stoneWall({ width: 6, height: 3, thickness: 0.5, style: 'rubble', seed: 5, budget: 300 }).build();
    const rich = stoneWall({ width: 6, height: 3, thickness: 0.5, style: 'rubble', seed: 5, budget: 6000 }).build();
    expect(rich.indices.length).toBeGreaterThan(cheap.indices.length);
  });

  it('gives every roof style an underside, so a roof is not a hole from below', () => {
    for (const style of ['pan', 'shingle', 'slate', 'thatch'] as const) {
      const data = roofPanel({ width: 4, slopeLength: 3, style, budget: 2600 }).build();
      expect(isSane(data)).toBe(true);
      // Probe across the slope rather than at one x: pan tiles really do have a
      // centimetre of gap at their joints, so a single sample can fall in a
      // joint and say the roof is missing when it is not.
      const probes = [0.07, 0.21, 0.36, 0.64, 0.92, 1.35, -0.48, -1.13];
      const covered = probes.filter((x) => rayHits(data, [x, 1, 1.5], [0, -1, 0], 2).length > 0).length;
      const underside = probes.filter((x) => rayHits(data, [x, -1, 1.5], [0, 1, 0], 2).length > 0).length;
      expect(covered).toBeGreaterThanOrEqual(probes.length - 1);
      expect(underside).toBeGreaterThanOrEqual(probes.length - 1);
    }
  });

  it('lays a roof panel over the full slope and keeps the ridge at z = 0', () => {
    const data = roofPanel({ width: 8, slopeLength: 5, style: 'shingle', overhang: 0.4 }).build();
    const bounds = boundsOf(data);
    expect(bounds.size[0]).toBeCloseTo(8, 1);
    // Ridge at z = 0, eave at z = slopeLength + overhang: the overhang belongs
    // at the eave, where it throws rain clear of the wall, not at the ridge.
    expect(bounds.min[2]).toBeGreaterThan(-0.05);
    expect(bounds.max[2]).toBeGreaterThan(5.3);
    expect(bounds.max[2]).toBeLessThan(5.7);
    expect(bounds.max[1]).toBeLessThan(0.6);
  });

  it('points a blade along +Z so leaves can be double-sided and lit', () => {
    const data = blade({ length: 0.3, width: 0.07, camber: 0.04 }).build();
    let forward = 0;
    let total = 0;
    for (let corner = 0; corner + 2 < data.indices.length; corner += 3) {
      const a = vertexAt(data, corner);
      const b = vertexAt(data, corner + 1);
      const c = vertexAt(data, corner + 2);
      const ab = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const ac = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
      const normal = ab.cross(ac);
      if (normal.lengthSq() < 1e-12) continue;
      total += 1;
      if (normal.normalize().z > 0.5) forward += 1;
    }
    expect(total).toBeGreaterThan(0);
    expect(forward).toBe(total);
  });

  it('stands a wheel and a gear in the XY plane with their axle along Z', () => {
    const wheelData = wheel({ radius: 0.7, width: 0.16, spokes: 12 }).build();
    const wheelBounds = boundsOf(wheelData);
    // The iron tyre stands proud of the felloe, so the wheel measures slightly
    // over its nominal diameter — as a real wheel does.
    expect(wheelBounds.size[0]).toBeGreaterThan(1.4);
    expect(wheelBounds.size[0]).toBeLessThan(1.55);
    expect(wheelBounds.size[1]).toBeGreaterThan(1.4);
    expect(wheelBounds.size[1]).toBeLessThan(1.55);
    expect(wheelBounds.size[2]).toBeLessThan(0.5);
    expect(signedVolume(wheelData)).not.toBe(0);

    const gearData = gear({ radius: 0.7, teeth: 14, thickness: 0.12 }).build();
    const gearBounds = boundsOf(gearData);
    expect(gearBounds.size[2]).toBeLessThan(0.4);
    expect(gearBounds.size[0]).toBeGreaterThan(1.3);
  });

  it('plans repeated units against a budget without dropping below the minimum', () => {
    const tight = planRepeatedUnits(40, 44, 300, 4);
    expect(tight.modeled).toBeGreaterThanOrEqual(4);
    expect(tight.modeled).toBeLessThan(40);
    expect(tight.textured).toBe(true);
    const roomy = planRepeatedUnits(6, 44, 3000, 4);
    expect(roomy.modeled).toBe(6);
    expect(roomy.textured).toBe(false);
  });

  it('pushes a smooth solid around with noise and leaves it sane', () => {
    const smooth = sphere(1, { widthSegments: 12, heightSegments: 8 });
    const before = smooth.build().positions.slice();
    const rough = sphere(1, { widthSegments: 12, heightSegments: 8 });
    displace(rough, { amplitude: 0.18, frequency: 2, octaves: 3, seed: 17, preserveBase: true });
    const after = rough.build();
    expect(after.positions.length).toBe(before.length);
    // Nothing may be left untouched, or the noise never reached the mesh.
    let moved = 0;
    for (let index = 0; index < before.length; index += 1) {
      if (Math.abs(before[index]! - after.positions[index]!) > 1e-6) moved += 1;
    }
    expect(moved).toBeGreaterThan(before.length * 0.5);
    expect(isSane(after)).toBe(true);
    expect(boundsOf(after).size[1]).toBeLessThan(2.6);
  });

  it('gives every generator a deterministic result for a given seed', () => {
    const first = stoneWall({ width: 5, height: 3, thickness: 0.5, style: 'rubble', seed: 42 }).build();
    const second = stoneWall({ width: 5, height: 3, thickness: 0.5, style: 'rubble', seed: 42 }).build();
    expect(Array.from(first.positions)).toEqual(Array.from(second.positions));
    const other = stoneWall({ width: 5, height: 3, thickness: 0.5, style: 'rubble', seed: 43 }).build();
    expect(Array.from(other.positions)).not.toEqual(Array.from(first.positions));
  });
});

describe('architectural shell', () => {
  it('builds a wall face to the requested length, height and thickness', () => {
    const data = wallFace({ length: 8, height: 3.2, thickness: 0.45, style: 'ashlar', seed: 1 }).build();
    const bounds = boundsOf(data);
    expect(isSane(data)).toBe(true);
    // Quoins and the relief of individual stones stand proud of the nominal face.
    expect(bounds.size[0]).toBeGreaterThan(7.9);
    expect(bounds.size[0]).toBeLessThan(8.6);
    expect(bounds.max[1]).toBeGreaterThan(3.15);
    expect(bounds.max[1]).toBeLessThan(3.3);
    expect(bounds.min[1]).toBeCloseTo(0, 2);
    expect(bounds.size[2]).toBeLessThan(0.9);
  });

  it('builds a doorway as piers, lintel and leaf rather than a hole in a panel', () => {
    const plain = wallFace({ length: 8, height: 3.2, thickness: 0.45, style: 'ashlar', seed: 1 }).build();
    const opening = wallFace({
      length: 8,
      height: 3.2,
      thickness: 0.45,
      style: 'ashlar',
      seed: 1,
      openings: [{ kind: 'door', atFraction: 0.5, width: 1.1, height: 2.15, fitted: false, surround: true }],
    }).build();
    expect(isSane(opening)).toBe(true);
    // The opening must be open: a ray at chest height straight through it meets
    // no surface at all. A wall built as one panel with a dark rectangle on it
    // fails here, because the panel is still there to hit.
    const head = 2.15;
    expect(rayHits(opening, [0, 1.1, -1.5], [0, 0, 1], 3)).toEqual([]);
    expect(rayHits(plain, [0, 1.1, -1.5], [0, 0, 1], 3).length).toBeGreaterThan(0);
    // Two metres to the side is still wall, so the piers are really there.
    expect(rayHits(opening, [2.5, 1.1, -1.5], [0, 0, 1], 3).length).toBeGreaterThan(0);
    // The lintel carries the wall above the opening, so a ray over the head hits.
    expect(rayHits(opening, [0, head + 0.2, -1.5], [0, 0, 1], 3).length).toBeGreaterThan(0);
    // And a ray at knee height passes through too: nothing fills the reveal.
    expect(rayHits(opening, [0, 0.4, -1.5], [0, 0, 1], 3)).toEqual([]);
    // Fitting the door adds the leaf, so the wall gets heavier, not lighter.
    const fitted = wallFace({
      length: 8,
      height: 3.2,
      thickness: 0.45,
      style: 'ashlar',
      seed: 1,
      openings: [{ kind: 'door', atFraction: 0.5, width: 1.1, height: 2.15, fitted: true, surround: true }],
    }).build();
    expect(fitted.indices.length).toBeGreaterThan(opening.indices.length);
    expect(fitted.indices.length).toBeGreaterThan(plain.indices.length);
    // With the leaf hung, the same ray now meets the door.
    expect(rayHits(fitted, [0, 1.1, -1.5], [0, 0, 1], 3).length).toBeGreaterThan(0);
  });

  it('raises a gable roof to the height its pitch implies', () => {
    const width = 8;
    const depth = 12;
    const pitch = 0.62;
    const overhang = 0.5;
    const data = gableRoof({ width, depth, pitch, overhang, style: 'shingle', seed: 3 }).build();
    const bounds = boundsOf(data);
    const rise = (width / 2) * Math.tan(pitch);
    expect(isSane(data)).toBe(true);
    expect(doubleFaces(data)).toBe(0);
    expect(bounds.max[1]).toBeGreaterThan(rise - 0.12);
    expect(bounds.max[1]).toBeLessThan(rise + 0.35);
    // Eaves land on the wall top, which is where the roof is placed from.
    // The eave itself is at wall height; only the fascia board hangs below it.
    expect(bounds.min[1]).toBeGreaterThan(-(overhang * Math.sin(pitch) + 0.26));
    expect(bounds.min[1]).toBeLessThan(0.06);
    // The roof spans the building, overhanging at both gable ends.
    expect(bounds.size[0]).toBeGreaterThan(width + overhang);
    expect(bounds.size[0]).toBeLessThan(width + overhang * 2 + 0.6);
    expect(bounds.size[2]).toBeGreaterThan(depth + overhang);
    expect(bounds.size[2]).toBeLessThan(depth + overhang * 2 + 0.4);
    // Symmetric about both centre lines, so it can be dropped on any building.
    expect(bounds.min[0]).toBeCloseTo(-bounds.max[0], 2);
    expect(bounds.min[2]).toBeCloseTo(-bounds.max[2], 2);
    // A roof is looked at from under its eaves too, so it must have an
    // underside: a ray upward from below the slope has to meet something.
    expect(rayHits(data, [width * 0.3, -0.6, 0], [0, 1, 0], rise + 2).length).toBeGreaterThan(0);
    // A ray straight down through the slope meets roofing; a ray down outside
    // the eave meets nothing. That is the difference between a roof and a pair
    // of tilted planes floating over a building.
    expect(rayHits(data, [width * 0.3, rise + 1, 0], [0, -1, 0], rise + 2).length).toBeGreaterThan(0);
    expect(rayHits(data, [width, rise + 1, 0], [0, -1, 0], rise + 2)).toEqual([]);
    expect(rayHits(data, [0, rise + 1, depth], [0, -1, 0], rise + 2)).toEqual([]);
  });

  it('keeps the eave at wall height and the ridge on the centre line', () => {
    const data = gableRoof({ width: 6, depth: 9, pitch: 0.7, overhang: 0.4, seed: 4 }).build();
    const half = 3;
    const eaveX = half + 0.4 * Math.cos(0.7);
    const onEave = countVerticesInside(data, { x: eaveX, y: 0, z: 0, radius: 0.22 });
    expect(onEave).toBeGreaterThan(0);
    const onRidge = countVerticesInside(data, { x: 0, y: half * Math.tan(0.7), z: 0, radius: 0.22 });
    expect(onRidge).toBeGreaterThan(0);
    // Nothing may float past the eave line: an overshoot here reads as a roof
    // that does not meet its walls.
    expect(outsideBounds(data, [-eaveX - 0.2, -0.6, -5.4], [eaveX + 0.2, half * Math.tan(0.7) + 0.35, 5.4])).toBeLessThan(0.05);
  });

  it('hips a roof to a ridge length that equal pitches imply', () => {
    const width = 7;
    const depth = 11;
    const pitch = 0.6;
    const overhang = 0.3;
    const data = hipRoof({ width, depth, pitch, overhang, style: 'slate', seed: 6 }).build();
    const bounds = boundsOf(data);
    const eaveW = width / 2 + overhang;
    const eaveD = depth / 2 + overhang;
    const rise = Math.min(eaveW, eaveD) * Math.tan(pitch);
    const ridgeHalf = Math.abs(eaveD - eaveW);
    expect(isSane(data)).toBe(true);
    expect(bounds.max[1]).toBeGreaterThan(rise - 0.15);
    expect(bounds.max[1]).toBeLessThan(rise + 0.35);
    expect(bounds.min[1]).toBeGreaterThan(-0.35);
    // Hip rolls and fascia stand proud of the eave line by a few centimetres.
    expect(bounds.size[0]).toBeGreaterThan(eaveW * 2);
    expect(bounds.size[0]).toBeLessThan(eaveW * 2 + 0.3);
    expect(bounds.size[2]).toBeGreaterThan(eaveD * 2);
    expect(bounds.size[2]).toBeLessThan(eaveD * 2 + 0.3);
    // The ridge runs along the long axis and is exactly the difference of the
    // half-spans — that is what "all four faces at the same pitch" forces.
    const onRidge = countVerticesInside(data, { x: 0, y: rise, z: ridgeHalf, radius: 0.2 });
    expect(onRidge).toBeGreaterThan(0);
    const beyondRidge = countVerticesInside(data, { x: 0, y: rise, z: ridgeHalf + 0.8, radius: 0.2 });
    expect(beyondRidge).toBe(0);
    expect(signedVolume(data)).toBeGreaterThan(0);
  });

  it('lays hip courses on the faces instead of leaving bare rafters', () => {
    const roofed = hipRoof({ width: 7, depth: 11, pitch: 0.6, overhang: 0.3, budget: 4000, seed: 6 }).build();
    const bare = hipRoof({ width: 7, depth: 11, pitch: 0.6, overhang: 0.3, budget: 200, seed: 6 }).build();
    expect(roofed.indices.length).toBeGreaterThan(bare.indices.length);
    // A course must sit proud of the face, halfway up the long slope.
    const slopePoint = { x: (7 / 2 + 0.3) * 0.5, y: (7 / 2 + 0.3) * 0.5 * Math.tan(0.6), z: 0 };
    expect(countVerticesInside(roofed, { ...slopePoint, radius: 0.28 })).toBeGreaterThan(0);
  });

  it('leans a shed roof from the wall down to its eave', () => {
    const depth = 1.4;
    const pitch = 0.4;
    const data = leanToRoof({ width: 2.4, depth, pitch, overhang: 0.2, seed: 8 }).build();
    const bounds = boundsOf(data);
    expect(isSane(data)).toBe(true);
    const drop = depth * Math.tan(pitch);
    const eaveY = -(depth / Math.cos(pitch) + 0.2) * Math.sin(pitch);
    // The wall edge stays at y = 0 and the eave falls by the pitch; the fascia
    // hangs a little below the eave, which is what a fascia is for.
    expect(bounds.max[1]).toBeLessThan(0.3);
    expect(bounds.max[1]).toBeGreaterThan(-0.05);
    expect(bounds.min[1]).toBeCloseTo(eaveY - 0.19, 1);
    expect(bounds.min[1]).toBeLessThan(-drop + 0.02);
    // The eave is where the pitch puts it, plus the overlap of the last course.
    expect(bounds.max[2]).toBeGreaterThan(depth + 0.2 * Math.cos(pitch) - 0.02);
    expect(bounds.max[2]).toBeLessThan(depth + 0.2 * Math.cos(pitch) + 0.14);
    // And the roof is actually there over the doorway it shelters.
    expect(rayHits(data, [0, 0.5, depth * 0.6], [0, -1, 0], 2).length).toBeGreaterThan(0);
    expect(bounds.size[0]).toBeGreaterThan(2.4);
  });

  it('lays conical courses on the cone surface, not floating off it', () => {
    const radius = 1.6;
    const height = 2.6;
    const data = conicalRoof({ radius, height, style: 'shingle', seed: 11, budget: 4000 }).build();
    expect(isSane(data)).toBe(true);
    const bounds = boundsOf(data);
    expect(bounds.max[1]).toBeGreaterThan(height * 0.95);
    expect(bounds.min[1]).toBeGreaterThan(-0.25);
    expect(bounds.max[0]).toBeLessThan(radius + 0.2);
    // Every course must lie within a tile's thickness of the cone's own surface;
    // this is the check that catches tiles hovering over a roof.
    let worst = 0;
    for (let index = 0; index < data.positions.length; index += 3) {
      const x = data.positions[index]!;
      const y = data.positions[index + 1]!;
      const z = data.positions[index + 2]!;
      const horizontal = Math.hypot(x, z);
      const surface = radius * Math.max(0, 1 - y / height);
      worst = Math.max(worst, horizontal - surface);
    }
    expect(worst).toBeLessThan(0.22);
  });

  it('domes to the requested rise and keeps ribs on the shell', () => {
    const radius = 3;
    const height = 2.6;
    const data = dome({ radius, height, ribs: 8, lantern: true, segments: 20 }).build();
    const bounds = boundsOf(data);
    expect(isSane(data)).toBe(true);
    expect(bounds.max[1]).toBeGreaterThan(height * 0.95);
    expect(bounds.max[0]).toBeLessThan(radius * 1.12);
    expect(bounds.min[1]).toBeGreaterThan(-0.1);
    // A rib that does not touch the shell is a floating stick. Sample a point on
    // the shell's own profile — a slightly pointed ogee, r = cos(a)·radius,
    // y = sin(a)^0.86·height — and require geometry there in both domes, with the
    // ribbed one standing proud of the plain one.
    const shell = dome({ radius, height, segments: 20 }).build();
    const a = 0.77;
    const sample = { x: Math.cos(a) * radius, y: Math.pow(Math.sin(a), 0.86) * height, z: 0, radius: 0.3 };
    expect(countVerticesInside(shell, sample)).toBeGreaterThan(0);
    expect(countVerticesInside(data, sample)).toBeGreaterThan(0);
    expect(data.indices.length).toBeGreaterThan(shell.indices.length);
    expect(bounds.max[0]).toBeGreaterThan(boundsOf(shell).max[0]);
  });

  it('batters a tower shaft so it narrows toward the top', () => {
    const data = towerShaft({ height: 12, radius: 2.4, shape: 'round', batter: 0.12, windows: 1, door: true, seed: 14, budget: 4000 }).build();
    const bounds = boundsOf(data);
    expect(isSane(data)).toBe(true);
    expect(bounds.max[1]).toBeGreaterThan(11.9);
    expect(bounds.max[1]).toBeLessThan(12.4);
    const foot = widestAtHeight(data, 0.6);
    const head = widestAtHeight(data, 10.5);
    expect(foot).toBeGreaterThan(head * 1.05);
    expect(signedVolume(data)).toBeGreaterThan(0);
  });

  it('keeps a square tower within its own footprint', () => {
    const data = towerShaft({ height: 9, radius: 2, shape: 'square', courses: 4, seed: 15, budget: 1500 }).build();
    const bounds = boundsOf(data);
    expect(bounds.max[0]).toBeLessThan(2 * 1.25);
    expect(bounds.max[1]).toBeGreaterThan(8.9);
    expect(isSane(data)).toBe(true);
  });

  it('runs battlements round all four sides of a wall top', () => {
    const data = parapetRun({ width: 10, depth: 8, thickness: 0.45, height: 0.75, seed: 16 }).build();
    const bounds = boundsOf(data);
    expect(bounds.size[0]).toBeCloseTo(10, 1);
    expect(bounds.size[2]).toBeCloseTo(8, 1);
    expect(bounds.max[1]).toBeGreaterThan(0.7);
    // Merlons must exist on the short sides too, not just where they are easy.
    // Sample the merlon tops, because a box has no vertex at half its height.
    expect(countVerticesInside(data, { x: 4.775, y: 0.75, z: 0, radius: 0.9 })).toBeGreaterThan(0);
    expect(countVerticesInside(data, { x: 0, y: 0.75, z: 3.775, radius: 0.9 })).toBeGreaterThan(0);
    // The wall top between them is open to the sky: no deck unless asked for.
    expect(rayHits(data, [0, 2, 0], [0, -1, 0], 2)).toEqual([]);
  });

  it('corbels a machicolation out from the wall it defends', () => {
    const data = machicolation({ width: 6, depth: 6, height: 0.85, seed: 17 }).build();
    const bounds = boundsOf(data);
    expect(bounds.size[0]).toBeGreaterThan(6);
    expect(bounds.max[1]).toBeGreaterThan(1);
    expect(isSane(data)).toBe(true);
  });

  it('frames a timber wall with posts, rails and braces', () => {
    const frame = timberFrame(6, 3.4, 0.4, 18, 1200).build();
    const bounds = boundsOf(frame);
    expect(isSane(frame)).toBe(true);
    // A diagonal brace swings slightly past the end posts before it is cut.
    expect(bounds.size[0]).toBeGreaterThan(5.9);
    expect(bounds.size[0]).toBeLessThan(6.4);
    expect(bounds.max[1]).toBeCloseTo(3.4, 1);
    // Braces are diagonal: some member must run across both X and Y.
    const diagonals = countDiagonalMembers(frame);
    expect(diagonals).toBeGreaterThan(0);
  });

  it('builds an arcade with columns, arches and spandrels', () => {
    const data = arcade({ length: 9, height: 3.4, bays: 3, depth: 0.5, seed: 19 }).build();
    const bounds = boundsOf(data);
    expect(isSane(data)).toBe(true);
    expect(bounds.size[0]).toBeGreaterThan(9);
    expect(bounds.max[1]).toBeGreaterThan(3.4);
    expect(doubleFaces(data)).toBe(0);
  });

  it('crowns a facade with a cornice that projects past the wall', () => {
    const data = cornice({ length: 10, depth: 0.42, modillions: true }).build();
    const bounds = boundsOf(data);
    expect(bounds.size[0]).toBeCloseTo(10, 1);
    expect(bounds.max[2]).toBeGreaterThan(0.2);
    expect(bounds.min[2]).toBeLessThan(-0.1);
  });

  it('gives a balcony a deck, brackets and a balustrade at handrail height', () => {
    const data = balcony({ width: 2.4, depth: 1, style: 'stone' }).build();
    const bounds = boundsOf(data);
    expect(isSane(data)).toBe(true);
    // A balustrade below 0.9 m is not a guard; above 1.2 m it hides the view.
    expect(bounds.max[1]).toBeGreaterThan(0.95);
    expect(bounds.max[1]).toBeLessThan(1.35);
    expect(bounds.size[2]).toBeGreaterThan(0.95);
    expect(countVerticesInside(data, { x: 0, y: 0.6, z: 0.9, radius: 0.2 })).toBeGreaterThan(0);
  });

  it('seats a flat roof deck under a parapet that sheds water', () => {
    const data = flatRoof({ width: 6, depth: 5, parapet: 0.9, style: 'adobe', seed: 20 }).build();
    const bounds = boundsOf(data);
    expect(bounds.size[0]).toBeGreaterThan(6);
    expect(bounds.max[1]).toBeGreaterThan(1);
    expect(isSane(data)).toBe(true);
  });

  it('caps a chimney with a corbel and pots', () => {
    const data = porchChimney();
    const bounds = boundsOf(data);
    expect(bounds.max[1]).toBeGreaterThan(1.9);
    expect(isSane(data)).toBe(true);
  });

  it('porches a door under a lean-to on posts', () => {
    const data = porch({ width: 1.9, depth: 1.3, height: 2.4, posts: 'timber', seed: 22 }).build();
    const bounds = boundsOf(data);
    expect(isSane(data)).toBe(true);
    expect(bounds.max[1]).toBeGreaterThan(2.4);
    expect(bounds.size[2]).toBeGreaterThan(1.2);
    expect(doubleFaces(data)).toBe(0);
  });

  it('floors a bay with joists under the deck', () => {
    const data = floorSlab({ width: 3, depth: 2.4, joists: true, seed: 23 }).build();
    const bounds = boundsOf(data);
    expect(bounds.size[0]).toBeCloseTo(3, 1);
    expect(bounds.size[2]).toBeCloseTo(2.4, 1);
    expect(bounds.min[1]).toBeLessThan(-0.1);
    // The joists hang below the deck, so there must be timber down there — a
    // slab with nothing under it is a floating floor.
    expect(countVerticesInside(data, { x: 0, y: -0.19, z: 1.1, radius: 0.25 })).toBeGreaterThan(0);
  });
});

describe('textures and materials', () => {
  const kinds: ModelTextureKind[] = [
    'brick', 'masonry', 'block', 'plaster', 'stucco', 'stone', 'marble', 'wood', 'plank', 'thatch',
    'shingle', 'slate', 'tile', 'log', 'bark', 'metal', 'hammered', 'riveted', 'rope', 'chain',
    'leather', 'fabric', 'glass', 'ceramic', 'paint', 'soil', 'sand', 'gravel', 'grass', 'foliage',
    'scale', 'fur', 'feather', 'wattle', 'bone', 'horn', 'crystal', 'rubber',
  ];

  it('produces square power-of-two textures with a full colour, normal and roughness set', () => {
    for (const kind of kinds) {
      const set = getModelTexture(kind, 64);
      expect(set.map.image.width).toBe(64);
      expect(set.map.image.height).toBe(64);
      expect(set.normalMap.image.width).toBe(64);
      expect(set.roughnessMap.image.width).toBe(64);
      expect(set.map.colorSpace).toBe(THREE.SRGBColorSpace);
      // The geometry carries its own tiling in its UVs, so a texture that also
      // repeats would tile twice and the surface would swim as it grows.
      expect(set.map.repeat.x).toBe(1);
      expect(set.map.repeat.y).toBe(1);
      expect(set.normalMap.repeat.y).toBe(1);
      expect(set.normalScale).toBeGreaterThan(0);
      const pixels = set.map.image.data as Uint8Array | null;
      expect(pixels).not.toBeNull();
      expect(Array.from(pixels ?? [])).toHaveLength(64 * 64 * 4);
    }
  });

  it('tiles without a seam by repeating whole rows and columns only', () => {
    // A fractional repeat leaves a partial cell at the wrap, which shows as a
    // straight seam across a wall. Sample the brick map across its wrap.
    const size = 64;
    const set = getModelTexture('brick', size);
    const data = set.map.image.data as Uint8Array | null;
    expect(data).not.toBeNull();
    const pixels = data ?? new Uint8Array();
    const at = (x: number, y: number): number => pixels[(y * size + ((x + size) % size)) * 4]!;
    // The pattern must actually have a pattern: brick against mortar.
    let darkest = 255;
    let lightest = 0;
    for (let y = 0; y < size; y += 4) {
      for (let x = 0; x < size; x += 4) {
        darkest = Math.min(darkest, at(x, y));
        lightest = Math.max(lightest, at(x, y));
      }
    }
    // Brick against mortar has to be visible in the colour map, not only in the
    // normal map: in flat light the normal map contributes almost nothing.
    expect(lightest - darkest).toBeGreaterThan(50);
    // Tileability: the step across the wrap must be no harsher than the typical
    // step inside the texture. A fractional row or column repeat leaves a hard
    // straight seam here, and that seam shows on every wall built from it.
    let internal = 0;
    let seam = 0;
    for (let y = 0; y < size; y += 1) {
      seam += Math.abs(at(size - 1, y) - at(0, y));
      for (let x = 1; x < size - 1; x += 1) internal += Math.abs(at(x, y) - at(x + 1, y));
    }
    const seamMean = seam / size;
    const internalMean = internal / (size * (size - 2));
    expect(seamMean).toBeLessThan(internalMean * 1.6);
  });

  it('caches one texture set per kind and size', () => {
    const first = getModelTexture('stone', 32);
    const second = getModelTexture('stone', 32);
    expect(first.map).toBe(second.map);
    expect(getModelTexture('stone', 64).map).not.toBe(first.map);
    expect(cachedModelTextures()).toContain('stone');
  });

  it('builds one shared material per surface and honours overrides', () => {
    const stone = getModelMaterial('stone-dressed');
    expect(stone).toBe(getModelMaterial('stone-dressed'));
    expect(getModelMaterial('stone-dressed', { color: 0x8899aa })).not.toBe(stone);
    expect(Object.keys(SURFACES).length).toBeGreaterThan(50);
    for (const id of Object.keys(SURFACES)) {
      expect(surfaceTexel(id)).toBeGreaterThan(0.05);
      expect(surfaceTexel(id)).toBeLessThan(20);
    }
    expect(materialsFor(['stone-dressed', 'wood-oak'])).toHaveLength(2);
  });

  it('keeps every palette inside the ten-material budget of an asset', () => {
    // A merged asset becomes one draw call per distinct material, so a palette
    // with more surfaces than an asset may use turns one model into many calls.
    for (const palette of Object.values(PALETTES)) {
      expect(palette.length).toBeLessThanOrEqual(10);
      for (const id of palette) expect(SURFACES[id]).toBeDefined();
      expect(pickSurface(palette, 0.5)).toBeTruthy();
    }
  });
});

describe('scale references', () => {
  it('keeps a large library of real-world sizes and resolves them', () => {
    expect(Object.keys(REFERENCE).length).toBeGreaterThan(150);
    const door = referenceSize('door');
    expect(door).not.toBeNull();
    expect(door![1]).toBeGreaterThan(1.8);
    expect(door![1]).toBeLessThan(2.4);
    expect(referenceSize('not-a-real-kind')).toBeNull();
  });

  it('normalizes a model to a reference height without stretching it', () => {
    const builder = box(1, 1, 1);
    const result = normalize(builder, { by: 'height', target: 3 });
    expect(result.factor).toBeCloseTo(3, 5);
    const bounds = boundsOf(builder.build());
    expect(bounds.size).toEqual([3, 3, 3]);
  });

  it('seats a model on the ground and centres it', () => {
    const builder = box(2, 1, 2).translate(4, 3, -5);
    const bounds = seatOnGround(builder);
    expect(bounds.min[1]).toBeCloseTo(0, 6);
    expect(bounds.min[0]).toBeCloseTo(-1, 6);
    expect(bounds.min[2]).toBeCloseTo(-1, 6);
  });

  it('measures dimensions for meta and warns when a model is off scale', () => {
    const tall = box(1, 40, 1).build();
    expect(dimensionsOf(tall)[1]).toBeCloseTo(40, 5);
    expect(scaleWarnings('door', tall).length).toBeGreaterThan(0);
    const right = box(0.95, 2.1, 0.06).build();
    expect(scaleWarnings('door', right)).toEqual([]);
    const dust = box(0.004, 0.004, 0.004).build();
    expect(scaleWarnings('house', dust).length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------- test helpers */

function countVerticesInside(data: MeshData, at: { x: number; y: number; z: number; radius: number }): number {
  let count = 0;
  const r2 = at.radius * at.radius;
  for (let index = 0; index < data.positions.length; index += 3) {
    const dx = data.positions[index]! - at.x;
    const dy = data.positions[index + 1]! - at.y;
    const dz = data.positions[index + 2]! - at.z;
    if (dx * dx + dy * dy + dz * dz <= r2) count += 1;
  }
  return count;
}

/** Widest horizontal extent of the vertices near a given height. */
function widestAtHeight(data: MeshData, y: number, band = 0.4): number {
  let widest = 0;
  for (let index = 0; index < data.positions.length; index += 3) {
    if (Math.abs(data.positions[index + 1]! - y) > band) continue;
    widest = Math.max(widest, Math.hypot(data.positions[index]!, data.positions[index + 2]!));
  }
  return widest;
}

/** Members whose long axis is neither level nor plumb: braces and rafters. */
function countDiagonalMembers(data: MeshData): number {
  let diagonals = 0;
  for (let corner = 0; corner + 2 < data.indices.length; corner += 3) {
    const a = vertexAt(data, corner);
    const b = vertexAt(data, corner + 1);
    const dx = Math.abs(b[0] - a[0]);
    const dy = Math.abs(b[1] - a[1]);
    if (dx > 0.3 && dy > 0.3) diagonals += 1;
  }
  return diagonals;
}

function porchChimney(): MeshData {
  return chimney({ width: 0.7, depth: 0.5, height: 1.6, pots: 2, seed: 21 }).build();
}

/* ------------------------------------------------------- nature components */

/**
 * Triangles whose winding faces up (or down) inside a height band.
 *
 * Read from the winding, not from the stored normals, because the normals are
 * authored and can be wrong while the winding is what the rasteriser obeys. This
 * is how a cut stump proves it has a top and a mushroom cap proves it has an
 * underside.
 */
function facingIn(data: MeshData, band: [number, number], up: boolean): number {
  let count = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const cross = new THREE.Vector3();
  for (let corner = 0; corner + 2 < data.indices.length; corner += 3) {
    a.set(...vertexAt(data, corner));
    b.set(...vertexAt(data, corner + 1));
    c.set(...vertexAt(data, corner + 2));
    const y = (a.y + b.y + c.y) / 3;
    if (y < band[0] || y > band[1]) continue;
    cross.subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if ((up && cross.y > 0) || (!up && cross.y < 0)) count += 1;
  }
  return count;
}

describe('nature components', () => {
  const plants: [string, MeshBuilder][] = [
    ['flower/daisy', flower({ style: 'daisy', seed: 3 })],
    ['flower/rose', flower({ style: 'rose', seed: 4 })],
    ['flower/tulip', flower({ style: 'tulip', seed: 5 })],
    ['flower/bell', flower({ style: 'bell', seed: 6 })],
    ['flower/thistle', flower({ style: 'thistle', seed: 7 })],
    ['flower/lily', flower({ style: 'lily', seed: 8 })],
    ['flower/umbel', flower({ style: 'umbel', seed: 9 })],
    ['flowerCluster', flowerCluster({ seed: 10, count: 6 })],
    ['mushroom/toadstool', mushroom({ style: 'toadstool', seed: 11 })],
    ['mushroom/amanita', mushroom({ style: 'amanita', seed: 12 })],
    ['mushroom/oyster', mushroom({ style: 'oyster', seed: 13 })],
    ['mushroom/morel', mushroom({ style: 'morel', seed: 14 })],
    ['mushroom/puffball', mushroom({ style: 'puffball', seed: 15 })],
    ['mushroom/shelf', mushroom({ style: 'shelf', seed: 16 })],
    ['mushroomCluster', mushroomCluster({ seed: 17, count: 6 })],
    ['fernFrond', fernFrond({ length: 0.6, seed: 18 })],
    ['fern', fern({ height: 0.8, seed: 19 })],
    ['reed', reed({ height: 1.6, seed: 20 })],
    ['bamboo', bamboo({ height: 3.6, seed: 21 })],
    ['grassTuft', grassTuft({ height: 0.45, seed: 22 })],
    ['cactus/saguaro', cactus({ style: 'saguaro', seed: 23 })],
    ['cactus/barrel', cactus({ style: 'barrel', seed: 24 })],
    ['cactus/pad', cactus({ style: 'pad', seed: 25 })],
    ['cactus/column', cactus({ style: 'column', spines: true, flower: true, seed: 26 })],
    ['bush', bush({ height: 1.2, seed: 27 })],
    ['bush/bare', bush({ height: 1.2, bare: true, berries: true, seed: 28 })],
    ['hedge', hedge({ length: 4, seed: 29, posts: true })],
    ['treeStump', treeStump({ seed: 30 })],
    ['treeStump/hollow', treeStump({ seed: 31, hollow: 0.5 })],
    ['fallenLog', fallenLog({ length: 3, seed: 32 })],
    ['deadTree', deadTree({ height: 6, seed: 33 })],
    ['leafLitter', leafLitter({ radius: 1, seed: 34 })],
  ];

  // A frond is a part, not a plant: it is attached to a crown at its base, and
  // its lowest pinnae curl a little below that attachment. Everything else is
  // placed by its base and must not sink.
  const parts = new Set(['fernFrond']);

  it.each(plants)('builds %s as sane geometry sitting on the ground', (name, builder) => {
    const { data, tris, bounds } = report(builder);
    expect(isSane(data)).toBe(true);
    expect(tris).toBeGreaterThan(20);
    expect(bounds.min[1], name).toBeGreaterThanOrEqual(parts.has(name) ? -0.02 : -1e-6);
    expect(bounds.size[1]).toBeGreaterThan(0.005);
    expect(new Set(data.materials).size).toBeLessThanOrEqual(10);
    for (const id of data.materials) expect(SURFACES[id]).toBeDefined();
  });

  it('makes the same plant from the same seed and a different one from another', () => {
    const first = fern({ height: 0.9, seed: 77 }).build();
    const again = fern({ height: 0.9, seed: 77 }).build();
    const other = fern({ height: 0.9, seed: 78 }).build();
    expect(Array.from(again.positions)).toEqual(Array.from(first.positions));
    expect(Array.from(other.positions)).not.toEqual(Array.from(first.positions));
  });

  it('treats the requested height as a contract, not a hint', () => {
    // A plant that overshoots or undershoots its nominal height breaks the
    // footprint a world plan records for it, so each generator is fitted.
    const cases: [string, number, MeshData][] = [
      ['daisy', 0.42, flower({ style: 'daisy', height: 0.42, seed: 3 }).build()],
      ['bell', 0.42, flower({ style: 'bell', height: 0.42, seed: 6 }).build()],
      ['thistle', 0.42, flower({ style: 'thistle', height: 0.42, seed: 7 }).build()],
      ['umbel', 0.42, flower({ style: 'umbel', height: 0.42, seed: 9 }).build()],
      ['toadstool', 0.12, mushroom({ height: 0.12, seed: 11 }).build()],
      ['amanita', 0.12, mushroom({ style: 'amanita', height: 0.12, seed: 12 }).build()],
      ['oyster', 0.12, mushroom({ style: 'oyster', height: 0.12, seed: 13 }).build()],
      ['morel', 0.12, mushroom({ style: 'morel', height: 0.12, seed: 14 }).build()],
      ['puffball', 0.12, mushroom({ style: 'puffball', height: 0.12, seed: 15 }).build()],
      ['fern', 0.8, fern({ height: 0.8, seed: 19 }).build()],
      ['reed', 1.6, reed({ height: 1.6, seed: 20 }).build()],
      ['bamboo', 3.6, bamboo({ height: 3.6, seed: 21 }).build()],
      ['grassTuft', 0.45, grassTuft({ height: 0.45, seed: 22 }).build()],
      ['saguaro', 2.8, cactus({ style: 'saguaro', height: 2.8, seed: 23 }).build()],
      ['barrel', 0.6, cactus({ style: 'barrel', height: 0.6, seed: 24 }).build()],
      ['pad', 1.1, cactus({ style: 'pad', height: 1.1, seed: 25 }).build()],
      ['bush', 1.2, bush({ height: 1.2, seed: 27 }).build()],
      ['treeStump', 0.5, treeStump({ height: 0.5, seed: 30 }).build()],
      ['deadTree', 6, deadTree({ height: 6, seed: 33 }).build()],
    ];
    for (const [name, asked, data] of cases) {
      const bounds = boundsOf(data);
      const ratio = bounds.max[1] / asked;
      expect(ratio, `${name} height ratio`).toBeGreaterThan(0.9);
      expect(ratio, `${name} height ratio`).toBeLessThan(1.03);
    }
  });

  it('spends what it is given and no more', () => {
    // Every generator must come in under its budget. Overshooting is how one
    // hero asset eats a whole scene's triangle allowance.
    const builders: [string, (budget: number) => MeshBuilder][] = [
      ['bush', (budget) => bush({ height: 1.2, seed: 27, budget })],
      ['fern', (budget) => fern({ height: 0.8, seed: 19, budget })],
      ['reed', (budget) => reed({ height: 1.6, seed: 20, budget })],
      ['bamboo', (budget) => bamboo({ height: 3.6, seed: 21, budget })],
      ['deadTree', (budget) => deadTree({ height: 6, seed: 33, budget })],
      ['hedge', (budget) => hedge({ length: 4, seed: 29, posts: true, budget })],
      ['mushroomCluster', (budget) => mushroomCluster({ seed: 17, count: 6, budget })],
      ['flowerCluster', (budget) => flowerCluster({ seed: 10, count: 6, budget })],
      ['cactus', (budget) => cactus({ seed: 23, budget })],
      ['grassTuft', (budget) => grassTuft({ seed: 22, budget })],
      ['treeStump', (budget) => treeStump({ seed: 30, budget })],
      ['fallenLog', (budget) => fallenLog({ length: 3, seed: 32, budget })],
    ];
    for (const budget of [400, 1200, 3000]) {
      for (const [name, make] of builders) {
        const tris = make(budget).build().indices.length / 3;
        // A floor is allowed: a frond is a rachis or it is nothing, and a
        // mushroom is a cap over a stipe. What is not allowed is a multiple.
        expect(tris, `${name} at ${budget}`).toBeLessThan(budget * 1.4 + 120);
      }
    }
  });

  it('keeps the whole plant when the budget drops, and drops detail instead', () => {
    // Coverage first: a poor fern is a fern with coarser fronds, not a fern with
    // one frond. A poor bush is a bush with fewer leaves per blob.
    const poorFern = fern({ height: 0.8, seed: 19, budget: 400 }).build();
    const richFern = fern({ height: 0.8, seed: 19, budget: 6000 }).build();
    expect(boundsOf(poorFern).size[0]).toBeGreaterThan(boundsOf(richFern).size[0] * 0.5);
    expect(boundsOf(poorFern).size[2]).toBeGreaterThan(boundsOf(richFern).size[2] * 0.5);
    const poorBush = bush({ height: 1.2, seed: 27, budget: 400 }).build();
    const richBush = bush({ height: 1.2, seed: 27, budget: 6000 }).build();
    expect(boundsOf(poorBush).size[0]).toBeGreaterThan(boundsOf(richBush).size[0] * 0.5);
    // A frond keeps its rachis and at least a few pinnae even when it is poor.
    const poorFrond = fernFrond({ length: 0.6, seed: 18, budget: 120 }).build();
    expect(poorFrond.indices.length / 3).toBeGreaterThan(30);
    expect(boundsOf(poorFrond).size[0]).toBeGreaterThan(0.05);
  });

  it('gives a mushroom cap an underside, so it is a shell and not a dome', () => {
    const cap = mushroom({ style: 'toadstool', height: 0.12, capRadius: 0.07, seed: 5, budget: 1400 }).build();
    const bounds = boundsOf(cap);
    // Sampled off the axis and off the z = 0 plane: a lathe closes on a single
    // apex vertex and its seam column sits at z = 0, so an axis-aligned ray
    // threads a point or rides an edge instead of hitting a triangle.
    const drop = rayHits(cap, [0.026, bounds.max[1] + 0.05, 0.011], [0, -1, 0], 0.1);
    expect(drop.length).toBeGreaterThan(0);
    // Seen from below at three quarters of the cap radius, the gill surface is
    // there too: a lathe traversed the wrong way would leave it facing up and
    // the cap would vanish from underneath.
    const under = rayHits(cap, [0.047, 0.01, 0.02], [0, 1, 0], 0.12);
    expect(under.length).toBeGreaterThan(0);
    // And by winding, in the band just under the rim.
    expect(facingIn(cap, [bounds.max[1] * 0.55, bounds.max[1] * 0.92], false)).toBeGreaterThan(0);
    expect(facingIn(cap, [bounds.max[1] * 0.94, bounds.max[1] + 0.001], true)).toBeGreaterThan(0);
    expect(doubleFaces(cap)).toBe(0);
  });

  it('gives every mushroom style a cap that closes on its stipe', () => {
    for (const style of ['toadstool', 'amanita', 'oyster', 'morel', 'puffball'] as const) {
      const data = mushroom({ style, height: 0.14, seed: 21, budget: 1600 }).build();
      const bounds = boundsOf(data);
      expect(isSane(data)).toBe(true);
      expect(doubleFaces(data), `${style} doubled faces`).toBe(0);
      // Straight down through the crown: it must be solid from above, sampled
      // off the axis because every style closes on a single apex vertex.
      const drop = rayHits(data, [bounds.size[0] * 0.22, bounds.max[1] + 0.04, 0], [0, -1, 0], 0.12);
      expect(drop.length, `${style} crown`).toBeGreaterThan(0);
    }
  });

  it('cuts a stump top that faces the sky', () => {
    for (const hollow of [0, 0.55]) {
      const data = treeStump({ height: 0.5, radius: 0.3, hollow, seed: 31 }).build();
      const bounds = boundsOf(data);
      const top = bounds.max[1];
      // The sawn face is the identifying feature of a stump, so it must be there
      // and it must face up: traversed outward it would face down and vanish.
      expect(facingIn(data, [top * 0.82, top + 0.001], true)).toBeGreaterThan(4);
      // Sweep the sawn face the way the roof tests do: one ray is not evidence,
      // because a ray can land on the axis, on the lathe seam, or in the hollow.
      // Every probe that is over wood must find wood.
      const core = hollow > 0 ? 0.3 * 0.9 * (1 - hollow) * 1.2 : 0.3 * 0.1;
      const rim = 0.3 * 0.94 * 1.05;
      let probes = 0;
      let covered = 0;
      for (const fraction of [0.2, 0.45, 0.7, 0.95]) {
        const r = core + (rim - core) * fraction;
        for (const bearing of [0.4, 1.5, 2.6, 3.9, 5.1]) {
          probes += 1;
          const hit = rayHits(
            data,
            [Math.cos(bearing) * r, top + 0.05, Math.sin(bearing) * r],
            [0, -1, 0],
            0.14,
          );
          if (hit.length > 0) covered += 1;
        }
      }
      expect(covered, `stump face coverage, hollow ${hollow}`).toBe(probes);
      if (hollow > 0) {
        // A hollow stump shows rotted wood inside, not the sky through the hole.
        const inside = rayHits(data, [core * 0.5, top * 0.9, core * 0.3], [0, -1, 0], 0.5);
        expect(inside.length).toBeGreaterThan(1);
      }
    }
  });

  it('lies a fallen log along its length and rests it on the ground', () => {
    const data = fallenLog({ length: 3.2, radius: 0.24, seed: 32 }).build();
    const bounds = boundsOf(data);
    expect(bounds.size[0]).toBeGreaterThan(3.0);
    expect(bounds.size[0]).toBeLessThan(4.0);
    // The log is long and low: stubs and moss raise it, but not by much.
    expect(bounds.size[1]).toBeLessThan(bounds.size[0] * 0.4);
    expect(bounds.min[1]).toBeCloseTo(0, 3);
    expect(isSane(data)).toBe(true);
  });

  it('grows bamboo nodes and puts leaves only where light reaches', () => {
    const plain = bamboo({ height: 3, culms: 1, seed: 21, leaves: false, budget: 2000 }).build();
    const leafy = bamboo({ height: 3, culms: 1, seed: 21, leaves: true, budget: 2000 }).build();
    expect(leafy.indices.length).toBeGreaterThan(plain.indices.length);
    expect(new Set(plain.materials).has('foliage-olive')).toBe(false);
    expect(new Set(leafy.materials).has('foliage-olive')).toBe(true);
    // Node rings are the identifying rhythm, so they survive a tight budget.
    const poor = bamboo({ height: 3, culms: 1, seed: 21, budget: 400 }).build();
    expect(poor.indices.length / 3).toBeGreaterThan(120);
  });

  it('renders leaf surfaces from both sides', () => {
    // blade() emits one surface. A canopy scatters leaves at every angle, so a
    // single-sided leaf material loses half the canopy to back-face culling.
    for (const id of [
      'foliage', 'foliage-dark', 'foliage-olive', 'foliage-palm', 'grass', 'moss',
      'needle', 'petal', 'petal-warm', 'petal-pale', 'reed',
    ]) {
      expect(getModelMaterial(id).side, id).toBe(THREE.DoubleSide);
    }
  });

  it('scatters leaf litter over a patch without driving it underground', () => {
    const data = leafLitter({ radius: 1.2, leaves: 40, seed: 34 }).build();
    const bounds = boundsOf(data);
    expect(bounds.min[1]).toBeGreaterThanOrEqual(-1e-6);
    // The patch covers the ground it was asked to cover.
    expect(bounds.size[0]).toBeGreaterThan(1.6);
    expect(bounds.size[2]).toBeGreaterThan(1.6);
    expect(bounds.size[1]).toBeLessThan(0.4);
  });

  it('keeps a hedge inside its run and on its clip line', () => {
    const data = hedge({ length: 5, height: 1.2, depth: 0.6, seed: 29, posts: true }).build();
    const bounds = boundsOf(data);
    // The run is authoritative: a hedge may not shorten to fit its budget.
    expect(bounds.size[0]).toBeGreaterThan(4.9);
    expect(bounds.size[0]).toBeLessThan(5.3);
    expect(bounds.max[1] / 1.2).toBeGreaterThan(0.88);
    expect(bounds.max[1] / 1.2).toBeLessThan(1.03);
    expect(bounds.min[1]).toBeCloseTo(0, 3);
  });

  it('builds every flower style with petals, not just a blob', () => {
    for (const style of ['daisy', 'rose', 'tulip', 'bell', 'thistle', 'lily', 'umbel'] as const) {
      const data = flower({ style, height: 0.4, seed: 12, budget: 900 }).build();
      const bounds = boundsOf(data);
      expect(isSane(data)).toBe(true);
      expect(data.indices.length / 3).toBeGreaterThan(80);
      // A bloom is wider than its stem: petals reach out from the crown.
      expect(Math.max(bounds.size[0], bounds.size[2])).toBeGreaterThan(0.03);
      expect(bounds.max[1] / 0.4).toBeGreaterThan(0.9);
      expect(bounds.max[1] / 0.4).toBeLessThan(1.03);
    }
  });

  it('gives a dead tree bare limbs and a broken crown', () => {
    const bare = deadTree({ height: 7, seed: 33, leaves: 0, budget: 3000 }).build();
    expect(new Set(bare.materials).size).toBe(1);
    const bounds = boundsOf(bare);
    // Limbs splay, so the crown is nearly as wide as the tree is tall.
    expect(Math.max(bounds.size[0], bounds.size[2])).toBeGreaterThan(bounds.size[1] * 0.3);
    const leafy = deadTree({ height: 7, seed: 33, leaves: 3, budget: 3000 }).build();
    expect(new Set(leafy.materials).has('foliage-olive')).toBe(true);
  });

  it('arms a saguaro and keeps the arms inside the plant', () => {
    const data = cactus({ style: 'saguaro', height: 4, arms: 2, seed: 23, budget: 3000 }).build();
    const bounds = boundsOf(data);
    expect(bounds.max[1] / 4).toBeGreaterThan(0.94);
    expect(bounds.max[1] / 4).toBeLessThan(1.03);
    // Arms reach out, so the silhouette is wider than a plain column.
    const column = cactus({ style: 'column', height: 4, seed: 23, budget: 3000 }).build();
    expect(bounds.size[0]).toBeGreaterThan(boundsOf(column).size[0] * 1.2);
  });
});
