'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {LiveEnhancementMath:math,EnhancementCache}=require('../static/live-enhancement-gpu.js');
const {ExploreEnhancement}=require('../static/live-enhancement.js');

test('tile interiors cover every output pixel exactly once and halos do not cross image edges',()=>{
  for(const [w,h] of [[1,1],[32,18],[193,385],[1409,1201]]){
    const seen=new Uint8Array(w*h);
    for(const [tw,th,x,y,cx,cy,ow,oh] of math.plan(w,h)){
      assert.ok(x-cx>=0&&y-cy>=0&&x-cx+tw<=w&&y-cy+th<=h);
      assert.ok(cx+ow<=tw&&cy+oh<=th);
      if(x>0)assert.equal(cx,6);if(y>0)assert.equal(cy,6);
      assert.equal(tw-cx-ow,Math.min(6,w-x-ow));assert.equal(th-cy-oh,Math.min(6,h-y-oh));
      for(let dy=0;dy<oh;dy++)for(let dx=0;dx<ow;dx++)seen[(y+dy)*w+x+dx]++;
    }
    assert.ok(seen.every(v=>v===1));
  }
});

test('neural work waits for settling, stops outside Explore, and never runs in Fast or Off',()=>{
  const settled={moving:false,loading:false,hidden:false,elapsed:800};
  for(const mode of ['ai','auto']){
    assert.equal(math.eligible({...settled,mode}),true);
    for(const flag of ['moving','loading','hidden'])assert.equal(math.eligible({...settled,mode,[flag]:true}),false);
  }
  assert.equal(math.eligible({...settled,mode:'off'}),false);
  assert.equal(math.eligible({...settled,mode:'fast'}),false);
  assert.equal(math.eligible({...settled,mode:'auto',elapsed:500}),false);
  assert.equal(math.eligible({...settled,mode:'ai',elapsed:500}),true);
  assert.equal(math.mode('invalid'),'off');
});

test('GPU cache is bounded, evicts least recently used textures, and releases memory on clear',()=>{
  const cache=new EnhancementCache(10),destroyed=[];
  const item=name=>({bytes:4,texture:{destroy:()=>destroyed.push(name)}});
  cache.put('a',item('a'));cache.put('b',item('b'));cache.get('a');cache.put('c',item('c'));
  assert.deepEqual(destroyed,['b']);assert.equal(cache.bytes,8);assert.equal(cache.get('b'),undefined);
  assert.equal(cache.put('huge',{bytes:11}),false);assert.equal(cache.bytes,8);
  cache.clear();assert.equal(cache.bytes,0);assert.equal(cache.items.size,0);assert.deepEqual(destroyed,['b','a','c']);
});

test('camera invalidation immediately hides enhanced pixels and cancels an old generation',()=>{
  const ui={generation:4,current:{texture:{}},canvas:{hidden:false},nextSample:99};
  ExploreEnhancement.prototype.invalidate.call(ui);
  assert.equal(ui.generation,5);assert.equal(ui.current,null);assert.equal(ui.canvas.hidden,true);assert.equal(ui.nextSample,0);
});

test('Off and original preview bypass enhanced exports',async()=>{
  for(const ui of [{engine:null},{engine:{},mode:'off'},{engine:{},mode:'auto',preview:true}]){
    assert.equal(await ExploreEnhancement.prototype.snapshotForExport.call(ui),null);
  }
});

test('enhanced exports record the real GPU method and reject camera changes during capture',async()=>{
  const ui={engine:{input:{},model:{sha256:'verified'},capture:async()=>({width:40,height:20})},mode:'auto',preview:false,original:()=>false,canvas:{hidden:false},generation:1,current:{texture:{}}};
  const result=await ExploreEnhancement.prototype.snapshotForExport.call(ui);
  assert.equal(result.metadata.ai,true);assert.equal(result.metadata.model_sha256,'verified');assert.equal(result.metadata.scientific_evidence,false);
  ui.current=null;
  assert.equal((await ExploreEnhancement.prototype.snapshotForExport.call(ui)).metadata.ai,false);
  ui.engine.capture=async()=>{ui.generation++;return {};};
  await assert.rejects(()=>ExploreEnhancement.prototype.snapshotForExport.call(ui),/view changed/);
});
