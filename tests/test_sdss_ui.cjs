const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
function harness(){
  const nodes=new Map(),pending=[];
  const defaults={'#sdss-ra':'202.469575','#sdss-dec':'47.1952583','#sdss-field':'13.8','#sdss-size':'2048','#sdss-plateifu':'8485-1901','#sdss-product':'ha','#sdss-snr':'3'};
  const $=id=>{if(!nodes.has(id))nodes.set(id,{value:defaults[id]||'100',style:{},textContent:'',hidden:false,disabled:false});return nodes.get(id);};
  const c=vm.createContext({$,console,URLSearchParams,Number,Math,Date,Promise,Error,JSON,
    jsonPost:(url,body)=>new Promise(resolve=>pending.push({url,body,resolve})),awaitAtlasJob:async j=>j.result,date:x=>x,esc:x=>x,
    state:{sky:{removeImageLayer(){}}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../static/sdss.js'),'utf8'),c);
  return {$,c,pending,run:s=>vm.runInContext(s,c)};
}
function image(id){return {id,url:'/image/'+id,name:id+'.jpg',ra:202,dec:47,fov:.23,size:2048,scale_arcsec:.4,created_at:'now',dark_fraction:0,navigate_url:'https://skyserver.sdss.org/'};}
test('SDSS field conversion validates coordinates and arcminute units',()=>{
  const p=harness();assert.ok(Math.abs(p.run('sdssField().fov')-.23)<1e-12);
  p.$('#sdss-ra').value='360';assert.throws(()=>p.run('sdssField()'),/valid sky coordinates/);
  p.$('#sdss-ra').value='202';p.$('#sdss-field').value='0.01';assert.throws(()=>p.run('sdssField()'),/field/);
});
test('late SDSS image responses cannot overwrite a newer chosen field',async()=>{
  const p=harness(),first=p.run('sdssLoadImage()'),second=p.run('sdssLoadImage()');
  p.pending[1].resolve({result:image('new')});await second;p.pending[0].resolve({result:image('old')});await first;
  assert.equal(p.run('sdssUI.image.id'),'new');assert.equal(p.$('#sdss-image').src,'/image/new');
  assert.equal(p.$('#sdss-original').download,'new.jpg');
});
test('pixel inspection reverses image Y into the native spectral array and honors masks',()=>{
  const p=harness();p.c.map={width:2,height:2,values:[[1,2],[3,null]],valid:[[true,true],[true,false]],unit:'km/s'};
  assert.match(p.run('sdssPixelAt(map,0,0)'),/3.0000 km\/s/);
  assert.match(p.run('sdssPixelAt(map,.9,.1)'),/masked/);
  assert.match(p.run('sdssPixelAt(map,.9,.9)'),/2.0000 km\/s/);
});
test('display controls affect the presentation without changing the source URL',()=>{
  const p=harness();p.$('#sdss-image').src='/original';p.$('#sdss-brightness').value='150';p.run('sdssStyle()');
  assert.match(p.$('#sdss-image').style.filter,/brightness\(1.5\)/);assert.equal(p.$('#sdss-image').src,'/original');
  p.run('sdssResetStyle()');assert.match(p.$('#sdss-image').style.filter,/brightness\(1\)/);
});
