import { createTerrainSampler } from '../../core/generation/terrain';
import type { Terrain } from '../../core/world-plan/schema';

export interface WalkPose { x: number; y: number; z: number; yaw: number; pitch: number }
export interface WalkInput { forward: boolean; back: boolean; left: boolean; right: boolean }
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
/** Place the camera near the previous focus, not inside the orbit camera's distant position. */
export function startWalk(terrain: Terrain, seed: number, focus: { x:number; z:number }, camera: { x:number; z:number }): WalkPose {
  let dx=camera.x-focus.x, dz=camera.z-focus.z;
  const length=Math.hypot(dx,dz);
  if (length < 1e-5) { dx=0; dz=1; } else { dx/=length; dz/=length; }
  const half=terrain.size/2-.5, distance=Math.min(8,terrain.size/4);
  const x=clamp(focus.x+dx*distance,-half,half), z=clamp(focus.z+dz*distance,-half,half);
  const y=createTerrainSampler(terrain,seed).heightAt(x,z)+1.7;
  return {x,y,z,yaw:Math.atan2(dx,dz),pitch:0};
}
/** Constant-speed navigation over sampled ground; no wall collision or swimming physics. */
export function moveWalk(pose: WalkPose, input: WalkInput, dt: number, terrain: Terrain, seed: number): WalkPose {
  const forward=Number(input.forward)-Number(input.back), side=Number(input.right)-Number(input.left);
  const length=Math.hypot(forward,side), t=clamp(Number.isFinite(dt) ? dt : 0,0,.05);
  let {x,z}=pose;
  if (length) {
    const f=forward/length, s=side/length, speed=6*t;
    x += (-Math.sin(pose.yaw)*f + Math.cos(pose.yaw)*s)*speed;
    z += (-Math.cos(pose.yaw)*f - Math.sin(pose.yaw)*s)*speed;
  }
  const half=terrain.size/2-.5;
  x=clamp(x,-half,half); z=clamp(z,-half,half);
  return { ...pose,x,z,y:createTerrainSampler(terrain,seed).heightAt(x,z)+1.7 };
}
export function lookWalk(pose: WalkPose, dx: number, dy: number): WalkPose {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return pose;
  return {...pose,yaw:pose.yaw-dx*.005,pitch:clamp(pose.pitch-dy*.005,-1.35,1.35)};
}
