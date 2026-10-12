'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const M=require('../src/engine/artwork-mass.js').ArtworkMass;
function rect(w,h,x0,y0,x1,y1){const a=new Uint8Array(w*h);for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)a[y*w+x]=1;return a}
const w=64,h=64,ink=rect(w,h,20,20,44,44);
test('outline gap measures to inner edge and width grows outwards',()=>{
 const a=M.masks(ink,w,h,{gap:4,width:3,bridge:0});
 assert.equal(a.outline[32*w+17],0);assert.equal(a.outline[32*w+15],1);
 assert.equal(a.outline[32*w+13],1);assert.equal(a.outline[32*w+12],0);
 assert.equal(a.outline[32*w+32],0);
});
test('overall outline fills internal holes and joins nearby dither fragments',()=>{
 const dots=ink.slice();for(let y=22;y<42;y++)for(let x=22;x<42;x++)dots[y*w+x]=0;
 for(let y=0;y<h;y++)dots[y*w+32]=0;
 const a=M.masks(dots,w,h,{gap:2,width:2,bridge:2});
 assert.equal(a.envelope[32*w+32],1);assert.equal(a.outline[32*w+32],0);
 assert.equal(a.base[32*w+32],1);assert.equal(a.base[20*w+20],0);
});
test('switch base is the inner outline envelope minus the original ink',()=>{
 const a=M.masks(ink,w,h,{gap:4,width:3,bridge:0});
 for(let i=0;i<ink.length;i++){assert.equal(a.base[i]&&ink[i],0);assert.equal(a.base[i]&&a.outline[i],0)}
 assert.equal(a.base[32*w+17],1);assert.equal(a.base[32*w+15],0);
});
test('empty artwork creates no outline or base and leaves its input untouched',()=>{
 const a=new Uint8Array(w*h),b=M.masks(a,w,h,{gap:4,width:3,bridge:2});
 assert.equal(b.base.some(Boolean),false);assert.equal(b.outline.some(Boolean),false);
 assert.deepEqual(a,new Uint8Array(w*h));
});
test('zero width has no outline, zero gap touches ink without covering it',()=>{
 assert.equal(M.masks(ink,w,h,{gap:4,width:0,bridge:0}).outline.some(Boolean),false);
 const a=M.masks(ink,w,h,{gap:0,width:2,bridge:0});
 assert.equal(a.outline[32*w+19],1);assert.equal(a.outline[32*w+20],0);
});
test('erased halftone plates export vector contours and retain named ink separations',()=>{
 const S=require('../src/export/svg.js').SvgOut;
 const d='M0 0H30V30H0Z M10 10V20H20V10Z';
 const render={matrix:{a:1,b:0,c:0,d:1,e:0,f:0},bbox:{x:0,y:0,width:30,height:30},shapes:[],plates:[{key:'c',label:'Cyan',colour:'#00ffff',d}],blend:'multiply'};
 const svg=S.build([render],{separations:true});
 assert.ok(svg.includes('id="Cyan"'));assert.ok(svg.includes(d));assert.ok(!svg.includes('<image'));
 assert.equal(S.platePath(render.plates[0]),d);
});
