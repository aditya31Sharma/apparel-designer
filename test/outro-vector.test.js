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

test('hex removal clears every matching tone, including partial alpha, without changing the source', () => {
  const px = { w: 4, h: 1, data: new Uint8ClampedArray([
    0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 80, 0, 0, 0, 90
  ]) };
  const original = px.data.slice();
  const p = { outroGrain: 0, outroRemoveColour: true, outroColour: '#999999' };
  const input = { items: [{ frame: true }], bbox: { x: 0, y: 0, width: 4, height: 1 }, pixels: px };
  const result = T.run(input, p, {});
  assert.deepEqual(Array.from(result.pixels.data), [
    0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 90
  ]);
  assert.deepEqual(px.data, original);
  assert.equal(result.items.length, 2);
  assert.equal(result.pixelsMatchGeometry, true);
  const svg = S.build([{ matrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    bbox: input.bbox, shapes: result.items.map(item => ({ ...item, d: G.itemPathData(item) })) }]);
  assert.doesNotMatch(svg, /#999999|rgba\(153,|<image|<filter|<mask|Gradient/);
  assert.match(svg, /<path /);
  assert.deepEqual(T.process(px, { ...p, outroRemoveColour: false }).data, T.process(px, { outroGrain: 0 }).data);
});

test('colour matching normalizes hex and never removes a near colour or invalid value', () => {
  const px = { w: 1, h: 1, data: new Uint8ClampedArray([255, 255, 255, 255]) };
  const p = { outroGrain: 0, outroDarken: 0, outroRemoveColour: true };
  for (const hex of ['#ffffff', ' FFFFFF ', '#FFF']) {
    assert.equal(T.process(px, { ...p, outroColour: hex }).data[3], 0);
  }
  for (const hex of ['#fffffe', '#ff0000', 'invalid', '#ffffffff', '']) {
    assert.equal(T.process(px, { ...p, outroColour: hex }).data[3], 255);
  }
});

test('removing the only colour exports empty transparent geometry rather than the original photo', () => {
  const input = { items: [{ frame: true }], bbox: { x: 0, y: 0, width: 1, height: 1 },
    pixels: { w: 1, h: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) } };
  const result = T.run(input, { outroRemoveColour: true, outroColour: '#000000' }, {});
  assert.equal(result.items.length, 0);
  assert.equal(result.photo, undefined);
  assert.equal(result.pixels.data[3], 0);
});
