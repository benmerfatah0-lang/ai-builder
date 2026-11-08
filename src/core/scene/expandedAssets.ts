import * as THREE from 'three';
import type { PrimitiveObject } from '../world-plan/schema';
import { EXPANDED_ASSET_IDS } from '../assets/expandedDefinitions';
import { addMesh, material } from './kit';
import { getSurfaceTexture } from './textures';

const supported = new Set<string>(EXPANDED_ASSET_IDS);
/** Self-contained low-poly geometry, with a small bounded number of meshes per asset. */
export function buildExpandedAsset(object: PrimitiveObject): THREE.Group | null {
  if (!supported.has(object.primitive)) return null;
  const group = new THREE.Group();
  const main = material(object.color, { roughness: .94, flatShading: true });
  const wood = material('#79583a', { roughness: .95, map: getSurfaceTexture('wood') });
  const stone = material('#969187', { roughness: .98, flatShading: true, map: getSurfaceTexture('stone') });
  const dark = material('#3d3530', { roughness: .95 });
  const leaf = material('#56814a', { roughness: .95, flatShading: true });
  const water = material('#68a9bb', { roughness: .4, metalness: .08 });
  const gold = material('#e5bc5b', { roughness: .9 });
  const box = (w:number,h:number,d:number,x:number,y:number,z:number,m:THREE.Material=main) => addMesh(group, new THREE.BoxGeometry(w,h,d), m, [x,y,z]);
  const cyl = (r1:number,r2:number,h:number,x:number,y:number,z:number,m:THREE.Material=main,n=8) => addMesh(group, new THREE.CylinderGeometry(r1,r2,h,n), m, [x,y,z]);
  const ball = (r:number,x:number,y:number,z:number,m:THREE.Material=main) => addMesh(group, new THREE.IcosahedronGeometry(r,1), m, [x,y,z]);
  const cone = (r:number,h:number,x:number,y:number,z:number,m:THREE.Material=main,n=8) => addMesh(group, new THREE.ConeGeometry(r,h,n), m, [x,y,z]);
  const posts = (x:number,z:number,h:number,m:THREE.Material=wood) => { for (const a of [-x,x]) for (const b of [-z,z]) box(.22,h,.22,a,h/2,b,m); };
  const wheel = (x:number,z:number) => { const part=cyl(.48,.48,.18,x,.5,z,dark,12); part.rotation.x=Math.PI/2; };
  switch(object.primitive) {
    case 'flower':
      for (const [x,z,h] of [[-.3,.1,.7],[.3,.2,.85],[0,-.3,.6]] as const) {
        cyl(.035,.05,h,x,h/2,z,leaf,5); ball(.12,x,h,z,gold);
        for(let i=0;i<5;i++){const a=i*Math.PI*2/5;ball(.11,x+Math.cos(a)*.16,h,z+Math.sin(a)*.16);}
      } break;
    case 'mushroom':
      for (const [x,z,s] of [[0,0,1],[-.42,.2,.65],[.35,.2,.55]] as const) {
        cyl(.12*s,.16*s,.45*s,x,.225*s,z,stone); const cap=ball(.33*s,x,.46*s,z);cap.scale.y=.52;
        ball(.06*s,x+.1*s,.59*s,z, gold);
      } break;
    case 'fern':
      for(let i=0;i<7;i++){const a=i*Math.PI*2/7;const leafPart=cone(.18,1,Math.cos(a)*.38,.5,Math.sin(a)*.38);leafPart.rotation.z=Math.sin(a)*.8;leafPart.rotation.x=Math.cos(a)*.8;} break;
    case 'grass-tuft':
      for(let i=0;i<7;i++){const a=i*Math.PI*2/7;const blade=cone(.12,.75,Math.cos(a)*.2,.38,Math.sin(a)*.2,main,4);blade.rotation.z=Math.sin(a)*.3;blade.rotation.x=Math.cos(a)*.3;} break;
    case 'bamboo':
      for(const [x,z,h] of [[0,0,4.1],[-.45,.15,3.2],[.35,-.25,3.6]] as const){cyl(.1,.12,h,x,h/2,z,main);for(let y=.7;y<h;y+=.7)cyl(.13,.13,.08,x,y,z,leaf);for(let y=2;y<h;y+=.8){const l=cone(.13,.75,x+.25,y,z,leaf,4);l.rotation.z=.9;}} break;
    case 'reed':
      for(const [x,z,h] of [[0,0,1.8],[-.3,.2,1.5],[.35,-.2,1.7],[.15,.35,1.4]] as const){cyl(.025,.04,h,x,h/2,z,leaf,5);cyl(.09,.09,.35,x,h-.1,z,wood);} break;
    case 'tree-stump': cyl(.55,.72,.9,0,.45,0,wood,10);cyl(.5,.5,.04,0,.92,0,main,10);break;
    case 'fallen-log': { const log=cyl(.45,.52,2.7,0,.52,0,wood,10);log.rotation.z=Math.PI/2; const cap=cyl(.38,.38,.05,1.35,.52,0,main,10);cap.rotation.z=Math.PI/2; break; }
    case 'dead-tree':
      cyl(.14,.35,3.2,0,1.6,0); for(const [x,y,z,r] of [[.5,2.4,0,-.8],[-.55,2.65,0,.9],[0,2.8,.55,.8]] as const){const branch=cyl(.07,.14,1.7,x,y,z);if(z)branch.rotation.x=r;else branch.rotation.z=r;} break;
    case 'crystal':
      for(const [x,z,h] of [[0,0,2.2],[-.6,.3,1.4],[.55,.35,1.6],[.2,-.6,1.1]] as const){cyl(.3,.4,h*.7,x,h*.35,z,main,5);cone(.3,h*.3,x,h*.85,z,main,5);} break;
    case 'castle':
      // Four solid corner towers and low curtain walls. Decorative exterior, no interiors.
      for(const x of [-4.5,4.5]) for(const z of [-3.5,3.5]){cyl(1.15,1.3,6,x,3,z,stone,8);cone(1.5,1.8,x,6.9,z,main,8);}
      box(6.5,3,.5,0,1.5,-3.5,stone);box(.5,3,5.5,-4.5,1.5,0,stone);box(.5,3,5.5,4.5,1.5,0,stone);
      box(2,3,.5,-3,1.5,3.5,stone);box(2,3,.5,3,1.5,3.5,stone);box(4,1,.5,0,3.5,3.5,stone);break;
    case 'stone-arch':
      box(.7,3.5,1,-1.9,1.75,0,stone);box(.7,3.5,1,1.9,1.75,0,stone);box(4.5,.7,1,0,3.85,0,main);break;
    case 'well':
      cyl(1.2,1.3,1.1,0,.55,0,stone,12);cyl(.85,.85,.06,0,1.12,0,water,12);
      box(.18,2.5,.18,-1,2.1,0,wood);box(.18,2.5,.18,1,2.1,0,wood);box(2.4,.25,1.1,0,3.3,0,wood);break;
    case 'windmill':
      cyl(1.1,1.65,5,0,2.5,0,main,10);cone(1.5,1.4,0,5.7,0,wood,10);box(.7,1.3,.12,0,.65,1.5,dark);
      for(let i=0;i<4;i++){const a=i*Math.PI/2;const blade=box(.45,2.3,.14,Math.sin(a)*1.3,4.1+Math.cos(a)*1.3,1.25,wood);blade.rotation.z=-a;} ball(.22,0,4.1,1.35,gold);break;
    case 'gazebo':
      cyl(2.1,2.1,.25,0,.13,0,wood,8);posts(1.25,1.25,2.7);cone(2.5,1.1,0,3.25,0,main,4).rotation.y=Math.PI/4;break;
    case 'tent': {
      const left=box(2.7,.12,3.5,-.9,1.2,0);left.rotation.z=-.75;
      const right=box(2.7,.12,3.5,.9,1.2,0);right.rotation.z=.75;
      box(.15,2.2,.15,0,1.1,1.7,wood);box(.15,2.2,.15,0,1.1,-1.7,wood);break; }
    case 'market-stall':
      posts(1.7,1,3);box(3.6,.18,1.8,0,1,0,wood);box(3.9,.2,2.6,0,3,0,main);
      for(const x of [-1.2,0,1.2]) ball(.3,x,1.35,0,gold);break;
    case 'fountain':
      cyl(1.9,2,.55,0,.28,0,stone,12);cyl(1.65,1.65,.08,0,.59,0,water,12);cyl(.24,.4,1.6,0,1.3,0,stone);cyl(.65,.55,.2,0,2.1,0,stone,10);cyl(.13,.13,.6,0,2.5,0,water,7);break;
    case 'watchtower':
      posts(1.4,1.4,5.5);box(3.4,.25,3.4,0,4.5,0,wood);box(3.6,.2,3.6,0,6,0,main);for(const x of [-1.5,1.5]) box(.15,1,3,x,5,0,wood); break;
    case 'shrine':
      box(3.5,.4,3.5,0,.2,0,stone);posts(1.2,1.2,2.5,stone);cone(2.5,1.1,0,3.05,0,main,4).rotation.y=Math.PI/4;box(.8,1.3,.8,0,1.05,0,gold);break;
    case 'lighthouse':
      cyl(.8,1.25,6,0,3,0,main,10);cyl(.88,.88,1.1,0,6.5,0,gold,10);cone(1.1,1,0,7.55,0,dark,10);box(.6,1.2,.1,0,.6,1.2,dark);break;
    case 'barrel':
      cyl(.55,.55,1.3,0,.65,0,main,12);for(const y of [.25,1.05])cyl(.57,.57,.08,0,y,0,dark,12);break;
    case 'crate':
      box(1.3,1.3,1.3,0,.65,0,main);for(const x of [-.48,.48])box(.1,1.3,.08,x,.65,.69,wood);box(1.3,.1,.08,0,.65,.69,wood);break;
    case 'bench':
      box(2.3,.15,.65,0,.7,0,main);box(2.3,.55,.12,0,1.08,-.28,wood);for(const x of [-.85,.85])box(.15,.7,.5,x,.35,0,wood);break;
    case 'table':
      box(2.2,.15,1.3,0,1,0,main);posts(.9,.45,.95);break;
    case 'chair':
      box(.8,.15,.8,0,.65,0,main);box(.8,.8,.12,0,1.05,-.34,wood);posts(.3,.3,.6);break;
    case 'campfire':
      for(let i=0;i<8;i++){const a=i*Math.PI*2/8;ball(.22,Math.sin(a)*.7,.2,Math.cos(a)*.7,stone);}
      {const l=cyl(.13,.13,1.1,0,.22,0,wood);l.rotation.z=Math.PI/2;const l2=cyl(.13,.13,1.1,0,.23,0,wood);l2.rotation.x=Math.PI/2;}
      cone(.35,1,0,.75,0,main,6);cone(.18,.6,.1,.65,.05,gold,6);break;
    case 'signpost': box(.18,2.6,.18,0,1.3,0,wood);box(1.8,.55,.16,.45,2.1,0,main);break;
    case 'flag': cyl(.07,.09,3.8,0,1.9,0,wood,6);box(1.8,.9,.08,.9,3.2,0,main);break;
    case 'wagon':
      box(3,.6,1.5,0,1.1,0,wood);box(3,.5,.12,0,1.65,-.7,main);box(3,.5,.12,0,1.65,.7,main);for(const x of [-1,1])for(const z of [-.85,.85])wheel(x,z);break;
    case 'hay-bale':
      box(1.6,1.1,1.1,0,.55,0,main);for(const x of [-.45,.45])box(.07,1.13,1.13,x,.56,0,wood);break;
    case 'column':
      box(1.2,.25,1.2,0,.125,0,stone);cyl(.4,.48,3.1,0,1.8,0,main,10);box(1.2,.25,1.2,0,3.5,0,stone);break;
  }
  return group;
}
