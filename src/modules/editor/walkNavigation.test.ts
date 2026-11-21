import { describe, expect, it } from 'vitest';
import { createEmptyWorldPlan } from '../../core/world-plan/factory';
import { lookWalk, moveWalk, startWalk } from './walkNavigation';
const terrain={...createEmptyWorldPlan({seed:1}).terrain,style:'flat' as const,heightScale:0,size:32};
describe('walk navigation',()=>{
  it('starts close to focus facing it and follows ground with bounded time steps',()=>{
    const start=startWalk(terrain,1,{x:0,z:0},{x:0,z:90});
    expect(start).toMatchObject({x:0,z:8,y:1.7,yaw:0});
    const next=moveWalk(start,{forward:true,back:false,left:false,right:false},1,terrain,1);
    expect(next.z).toBeCloseTo(7.7); expect(next.y).toBe(1.7);
  });
  it('normalizes diagonal speed, clamps map bounds and limits pitch',()=>{
    const start=startWalk(terrain,1,{x:0,z:0},{x:0,z:90});
    const input={forward:true,back:false,left:false,right:true};
    const step=moveWalk(start,input,.05,terrain,1);
    expect(Math.hypot(step.x-start.x,step.z-start.z)).toBeCloseTo(.3);
    const edge=moveWalk({...start,x:15.49,yaw:0},{forward:false,back:false,left:false,right:true},.05,terrain,1);
    expect(edge.x).toBeLessThanOrEqual(15.5);
    expect(lookWalk(start,100,99999).pitch).toBe(-1.35);
    expect(lookWalk(start,Number.NaN,0)).toBe(start);
  });
});
