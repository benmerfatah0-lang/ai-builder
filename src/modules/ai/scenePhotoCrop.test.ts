import { describe, expect, it } from 'vitest';
import { scenePhotoCrop } from './scenePhotoCrop';

describe('full resolution local scene outline crop',()=>{
  it('preserves a small object by cropping from the original before resampling',()=>{
    const crop=scenePhotoCrop([{x:9.6,y:9.6},{x:12,y:9.6},{x:12,y:12},{x:9.6,y:12}],24,24,960,960);
    expect(crop.x).toBeCloseTo(384); expect(crop.y).toBeCloseTo(384); expect(crop.width).toBeCloseTo(96); expect(crop.height).toBeCloseTo(96);
    expect([crop.pixelWidth,crop.pixelHeight]).toEqual([24,24]); expect(crop.mask.reduce((a,b)=>a+b,0)).toBe(576);
  });
  it('retains aspect ratio and mask holes/outside outline',()=>{
    const crop=scenePhotoCrop([{x:3,y:3},{x:21,y:3},{x:3,y:9}],24,24,240,240);
    expect([crop.pixelWidth,crop.pixelHeight]).toEqual([24,8]);
    expect(crop.mask[0]).toBe(1); expect(crop.mask[crop.mask.length-1]).toBe(0);
  });
  it('rejects invalid, degenerate or tiny selections',()=>{
    expect(()=>scenePhotoCrop([{x:1,y:1},{x:1,y:2},{x:1,y:3}],24,24,960,960)).toThrow();
    expect(()=>scenePhotoCrop([{x:1,y:1},{x:1.001,y:1},{x:1,y:1.001}],24,24,24,24)).toThrow();
    expect(()=>scenePhotoCrop([{x:1,y:1},{x:25,y:1},{x:1,y:2}],24,24,240,240)).toThrow();
  });
});
