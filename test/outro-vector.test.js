'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/engine/tenzen-outro.js').TenzenOutro;
const G = require('../src/engine/geom.js').Geom;
const S = require('../src/export/svg.js').SvgOut;

test('vector contours reproduce each treated tone and transparency', () => {
  const w=17,h=13,data=new Uint8ClampedArray(w*h*4);
  for(let i=0;i<data.length;i+=4){data[i]=i%256;data[i+1]=(i*3)%256;data[i+2]=(i*7)%256;data[i+3]=(i*5)%256;}
  const photo=T.process({w,h,data}),items=T.vectorize(photo,{x:10,y:20,width:w*2,height:h*3});
  const actual=new Uint8ClampedArray(data.length);
  for(const item of items){
    const paint=item.fill.match(/[\d.]+/g).map(Number),alpha=paint.length===4?Math.round(paint[3]*255):255;
    for(let r=0;r<item.offsets.length-1;r++){
      const p=item.points,o=item.offsets[r]*2;
      const x0=Math.round((p[o]-10)/2),x1=Math.round((p[o+2]-10)/2),y0=Math.round((p[o+1]-20)/3),y1=Math.round((p[o+5]-20)/3);
      for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const i=(y*w+x)*4;actual.set([paint[0],paint[0],paint[0],alpha],i);}
    }
  }
  assert.deepEqual(actual,photo.data);
});
test('solid regions merge vertically, transparent regions create no geometry',()=>{
  const px={w:20,h:10,data:new Uint8ClampedArray(20*10*4).fill(255)};
  const box={x:0,y:0,width:200,height:100};
  const items=T.vectorize(px,box);
  assert.equal(items.length,1);assert.equal(items[0].points.length,8);assert.equal(items[0].offsets.length,2);
  px.data.fill(0);assert.equal(T.vectorize(px,box).length,0);
});
test('outro SVG export contains geometry with no embedded bitmap',()=>{
  const px={w:2,h:1,data:new Uint8ClampedArray([0,0,0,255,153,153,153,128])};
  const box={x:0,y:0,width:20,height:10};
  const shapes=T.vectorize(px,box).map(item=>({...item,d:G.itemPathData(item)}));
  const svg=S.build([{matrix:{a:1,b:0,c:0,d:1,e:0,f:0},bbox:box,shapes}]);
  assert.match(svg,/<path /);assert.doesNotMatch(svg,/<image|data:image/);
});
