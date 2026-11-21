import * as THREE from 'three';
import type { ArenaDef, BossDef, RegionDef, Vec2 } from './types';

/**
 * Overlay layer drawn on top of the diorama: the suggested progression route,
 * arena rings + boss emblems, region borders and the selected-region beacon.
 *
 * Kept separate from the scene builder so the 3D app and the offline preview
 * renderer can both draw exactly the same design annotations.
 */

export const ROUTE_STOPS: Vec2[] = [
  [0, 148], [-6, 138], [0, 118], [2, 66], [-26, 44], [0, 20], [2, -10],
  [10, -60], [10, -80], [14, -96], [44, -98], [-44, -100], [-46, -124],
];

export interface OverlayOptions {
  heightAt: (x: number, z: number) => number;
  regions: RegionDef[];
  arenas: ArenaDef[];
  bosses: BossDef[];
  showRoute?: boolean;
  showArenas?: boolean;
  showRegions?: boolean;
  beacon?: { center: Vec2; color?: string } | null;
}

export interface OverlayHandle {
  group: THREE.Group;
  pulses: THREE.Mesh[];
  emblems: THREE.Mesh[];
  animate: (elapsed: number) => void;
  dispose: () => void;
}

function track<T extends THREE.BufferGeometry | THREE.Material>(bucket: (THREE.BufferGeometry | THREE.Material)[], item: T): T {
  bucket.push(item);
  return item;
}

export function buildOverlays(options: OverlayOptions): OverlayHandle {
  const group = new THREE.Group();
  group.name = 'map-overlays';
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];
  const pulses: THREE.Mesh[] = [];
  const emblems: THREE.Mesh[] = [];
  const { heightAt } = options;

  if (options.showRoute) {
    const routeMaterial = track(
      disposables,
      new THREE.MeshBasicMaterial({ color: '#ffcf5c', transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false }),
    );
    for (let index = 1; index < ROUTE_STOPS.length; index += 1) {
      const a = ROUTE_STOPS[index - 1]!;
      const b = ROUTE_STOPS[index]!;
      const yA = heightAt(a[0], a[1]);
      const yB = heightAt(b[0], b[1]);
      const start = new THREE.Vector3(a[0], yA + 2.6, a[1]);
      const middle = new THREE.Vector3((a[0] + b[0]) / 2, Math.max(yA, yB) + 5.0, (a[1] + b[1]) / 2);
      const end = new THREE.Vector3(b[0], yB + 2.6, b[1]);
      const curve = new THREE.QuadraticBezierCurve3(start, middle, end);
      const tube = new THREE.Mesh(track(disposables, new THREE.TubeGeometry(curve, 14, 0.36, 6, false)), routeMaterial);
      tube.renderOrder = 5;
      group.add(tube);
    }
    const pulseGeometry = track(disposables, new THREE.SphereGeometry(1.05, 8, 6));
    for (let index = 0; index < 6; index += 1) {
      const dot = new THREE.Mesh(
        pulseGeometry,
        track(
          disposables,
          new THREE.MeshBasicMaterial({ color: '#fff4c9', transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false }),
        ),
      );
      dot.userData.pulse = index / 6;
      dot.renderOrder = 6;
      pulses.push(dot);
      group.add(dot);
    }
  }

  if (options.showArenas) {
    for (const arena of options.arenas) {
      const boss = options.bosses.find((entry) => entry.arenaId === arena.id);
      const color =
        boss?.tier === 'optional' ? '#d9a8ff' : boss?.tier === 'final' ? '#ffe066' : '#ff9a80';
      const ring = new THREE.Mesh(
        track(disposables, new THREE.TorusGeometry(arena.radius + 1.2, 0.34, 6, 52)),
        track(
          disposables,
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false }),
        ),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(arena.position[0], heightAt(arena.position[0], arena.position[1]) + 0.55, arena.position[1]);
      ring.userData.bossId = boss?.id;
      ring.userData.regionId = arena.regionId;
      ring.renderOrder = 4;
      group.add(ring);

      const emblem = new THREE.Mesh(
        track(disposables, new THREE.OctahedronGeometry(1.7, 0)),
        track(
          disposables,
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false }),
        ),
      );
      emblem.position.set(
        arena.position[0],
        heightAt(arena.position[0], arena.position[1]) + arena.radius * 0.45 + 7,
        arena.position[1],
      );
      emblem.userData.bossId = boss?.id;
      emblem.userData.regionId = arena.regionId;
      emblem.userData.baseY = emblem.position.y;
      emblem.renderOrder = 6;
      emblems.push(emblem);
      group.add(emblem);

      // Tether: a faint beam from the arena floor up to the emblem, so the gem
      // reads as pinned over this ring rather than floating at random.
      const tetherHeight = emblem.position.y - heightAt(arena.position[0], arena.position[1]);
      const tether = new THREE.Mesh(
        track(disposables, new THREE.CylinderGeometry(0.09, 0.09, tetherHeight, 4, 1, true)),
        track(
          disposables,
          new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.3,
            depthWrite: false,
            toneMapped: false,
          }),
        ),
      );
      tether.position.set(arena.position[0], heightAt(arena.position[0], arena.position[1]) + tetherHeight / 2, arena.position[1]);
      tether.renderOrder = 3;
      group.add(tether);
    }
  }

  if (options.showRegions) {
    for (const region of options.regions) {
      const points = region.polygon.map(
        ([x, z]) => new THREE.Vector3(x, heightAt(x, z) + 0.8, z),
      );
      points.push(points[0]!.clone());
      const geometry = track(disposables, new THREE.BufferGeometry().setFromPoints(points));
      const line = new THREE.Line(
        geometry,
        track(
          disposables,
          new THREE.LineDashedMaterial({
            color: region.color,
            dashSize: 3.6,
            gapSize: 2.4,
            transparent: true,
            opacity: 0.95,
            toneMapped: false,
            depthWrite: false,
          }),
        ),
      );
      line.computeLineDistances();
      line.renderOrder = 3;
      group.add(line);
    }
  }

  if (options.beacon) {
    const { center, color } = options.beacon;
    const y = heightAt(center[0], center[1]);
    const beam = new THREE.Mesh(
      track(disposables, new THREE.CylinderGeometry(0.3, 1.1, 18, 10, 1, true)),
      track(
        disposables,
        new THREE.MeshBasicMaterial({
          color: color ?? '#fff1c4',
          transparent: true,
          opacity: 0.24,
          depthWrite: false,
          side: THREE.DoubleSide,
          toneMapped: false,
        }),
      ),
    );
    beam.position.set(center[0], y + 9, center[1]);
    beam.renderOrder = 2;
    group.add(beam);
    const disc = new THREE.Mesh(
      track(disposables, new THREE.RingGeometry(1.1, 2.0, 32)),
      track(
        disposables,
        new THREE.MeshBasicMaterial({
          color: color ?? '#fff1c4',
          transparent: true,
          opacity: 0.5,
          side: THREE.DoubleSide,
          depthWrite: false,
          toneMapped: false,
        }),
      ),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(center[0], y + 0.5, center[1]);
    group.add(disc);
  }

  const animate = (elapsed: number) => {
    for (const [index, dot] of pulses.entries()) {
      const t = ((elapsed * 0.055 + index / Math.max(1, pulses.length)) % 1) * (ROUTE_STOPS.length - 1);
      const segment = Math.min(ROUTE_STOPS.length - 2, Math.floor(t));
      const local = t - segment;
      const a = ROUTE_STOPS[segment]!;
      const b = ROUTE_STOPS[segment + 1]!;
      const x = a[0] + (b[0] - a[0]) * local;
      const z = a[1] + (b[1] - a[1]) * local;
      dot.position.set(x, heightAt(x, z) + 3.6, z);
      dot.scale.setScalar(0.7 + Math.sin(elapsed * 4 + index) * 0.16);
    }
    for (const emblem of emblems) {
      emblem.position.y = (emblem.userData.baseY as number) + Math.sin(elapsed * 1.3 + emblem.position.x * 0.1) * 0.9;
      emblem.rotation.y = elapsed * 0.6;
    }
  };

  return {
    group,
    pulses,
    emblems,
    animate,
    dispose: () => {
      for (const item of disposables) item.dispose();
    },
  };
}
