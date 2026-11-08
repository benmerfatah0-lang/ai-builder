import { describe, expect, it } from 'vitest';
import { ADE_CLASSES, semanticRegions } from './semanticScene';

describe('semantic segmentation regions',()=>{
  it('uses the ADE20K model class order and splits disconnected regions, not instances',()=>{
    expect(ADE_CLASSES).toHaveLength(150);
    expect([4,21,34,60,113,128].map(i=>ADE_CLASSES[i])).toEqual(['tree','water','rock','river','waterfall','lake']);
    const labels=new Uint8Array(4096).fill(2);
    for(let y=0;y<5;y++)for(let x=0;x<5;x++)labels[y*64+x]=4;
    for(let y=10;y<13;y++)for(let x=40;x<43;x++)labels[y*64+x]=4;
    for(let y=40;y<45;y++)for(let x=15;x<25;x++)labels[y*64+x]=60;
    const result=semanticRegions(labels);
    expect(result.ignored).toContain('sky');expect(result.regions.map(r=>r.label)).toEqual(['river','tree','tree']);
    expect(result.regions[1]).toMatchObject({x:0,y:0,width:5,height:5});
  });
  it('skips tiny regions and reports rather than silently hiding the 30-area cap',()=>{
    const labels=new Uint8Array(4096).fill(2);
    for(let n=0;n<35;n++){let x=(n%7)*9,y=Math.floor(n/7)*9;for(let dy=0;dy<2;dy++)for(let dx=0;dx<3;dx++)labels[(y+dy)*64+x+dx]=4;}
    labels[63*64+63]=34;
    const result=semanticRegions(labels);expect(result.regions).toHaveLength(30);expect(result.truncated).toBe(5);
    expect(()=>semanticRegions(new Uint8Array(12))).toThrow();labels[100]=150;expect(()=>semanticRegions(labels)).toThrow();
  });
});

it('maps recognized furniture and structures to the expanded local catalog', async () => {
  const { regionsToSceneMarks } = await import('./semanticScene');
  const { createImageScene } = await import('./imageScene');
  const labels = ['table','chair','flower','bench','fountain','barrel','tent','flag'];
  const regions = labels.map((label, i) => ({classId:ADE_CLASSES.indexOf(label),label,x:i*5,y:3,width:4,height:4,pixels:[1,2,3,4,5,6]}));
  const result = regionsToSceneMarks(regions, {} as HTMLImageElement, {kind:'local',title:'x',author:'user',license_name:'unknown'});
  expect(result.failed).toEqual([]);
  expect(result.marks.map((mark)=>mark.type)).toEqual(labels);
  const plan=createImageScene('image',result.marks,7);
  expect(plan.objects.map((object)=>object.kind === 'primitive' ? object.primitive : object.kind)).toEqual(labels);
});
