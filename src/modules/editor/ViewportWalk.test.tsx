// @vitest-environment happy-dom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createEmptyWorldPlan } from '../../core/world-plan/factory';
import { Viewport } from './Viewport';

const observed = vi.hoisted(() => ({ camera: null as null | import('three').PerspectiveCamera, renderCount:0 }));
vi.mock('../../core/scene/renderer', () => ({
  createViewportRenderer: () => ({ renderer: { domElement:document.createElement('canvas'), info:{render:{calls:0,triangles:0}}, setSize:()=>{},setPixelRatio:()=>{},dispose:()=>{},forceContextLoss:()=>{},render:(_scene:unknown,camera:import('three').PerspectiveCamera)=>{ observed.camera=camera; observed.renderCount++; } }, profile:{api:'webgl2',gpu:'test',vendor:'test',maxTextureSize:1024,antialias:false} }),
  WebGLUnavailableError: class extends Error {}, captureViewportPng:async()=>new Blob(), downloadBlob:()=>{},
}));
vi.mock('three/examples/jsm/controls/OrbitControls.js', async () => {
  const THREE=await import('three');
  return { OrbitControls: class { target=new THREE.Vector3(); enabled=true; maxDistance=100; touches={}; constructor(public camera:import('three').PerspectiveCamera) {} update(){ this.camera.lookAt(this.target); } dispose(){} } };
});
vi.mock('three/examples/jsm/controls/TransformControls.js', async () => {
  const THREE=await import('three');
  return { TransformControls: class { object=null; dragging=false; axis=null; enabled=true; getHelper(){return new THREE.Group();} setSize(){} setSpace(){} setMode(){} addEventListener(){} detach(){} attach(){} dispose(){} } };
});
afterEach(()=>{cleanup(); observed.camera=null; observed.renderCount=0;});
describe('walk viewport',()=>{
  it('moves on hold, looks on drag, disables picking and restores the orbit camera',async()=>{
    const world=createEmptyWorldPlan({seed:1}); world.terrain={...world.terrain,style:'flat',heightScale:0,resolution:16,waterLevel:null};
    const saved=JSON.stringify(world); const select=vi.fn();
    function App(){ const [walk,setWalk]=useState(false); return <Viewport plan={world} selection={[]} tool="translate" space="world" snap={false} showGrid={false} onSelect={select} onTransformCommit={()=>{}} walkMode={walk} onWalkModeChange={setWalk}/>; }
    const {container}=render(<App/>);
    const toggle=await screen.findByRole('button',{name:'التجول في العالم'});
    await waitFor(()=>expect((toggle as HTMLButtonElement).disabled).toBe(false));
    expect(observed.camera).toBeTruthy(); const original=observed.camera!.position.clone();
    fireEvent.click(toggle);
    const up=screen.getByRole('button',{name:'تقدم'});
    await waitFor(()=>expect(observed.camera!.position.y).toBeCloseTo(1.7));
    const before=observed.camera!.position.clone();
    fireEvent.pointerDown(up,{pointerId:1,button:0});
    await waitFor(()=>expect(observed.camera!.position.distanceTo(before)).toBeGreaterThan(.08),{timeout:1000});
    fireEvent.pointerUp(up,{pointerId:1,button:0});
    const canvas=container.querySelector('canvas')!; const angle=observed.camera!.rotation.y;
    fireEvent.pointerDown(canvas,{pointerId:2,pointerType:'touch',clientX:10,clientY:10,button:0});
    fireEvent.pointerMove(canvas,{pointerId:2,pointerType:'touch',clientX:60,clientY:10});
    fireEvent.pointerUp(canvas,{pointerId:2,pointerType:'touch',clientX:60,clientY:10,button:0});
    await waitFor(()=>expect(observed.camera!.rotation.y).not.toBeCloseTo(angle));
    expect(select).not.toHaveBeenCalled();
    expect(JSON.stringify(world)).toBe(saved);
    fireEvent.click(screen.getByRole('button',{name:'الخروج من التجول'}));
    await waitFor(()=>expect(observed.camera!.position.distanceTo(original)).toBeLessThan(.001));
    expect(screen.queryByRole('group',{name:'أزرار التجول'})).toBeNull();
  });
});
