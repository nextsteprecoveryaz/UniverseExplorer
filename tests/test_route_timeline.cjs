const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const ctx=vm.createContext({Math});
for(const f of ['flight-math.js','route-timeline.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../static',f),'utf8'),ctx);
const timeline=vm.runInContext('RouteTimeline',ctx),flight=vm.runInContext('FlightMath',ctx);
const view=(ra=0)=>({ra,dec:0,fov:10,roll:0,survey:'optical',projection:'AIT'});

test('waypoint timelines arrive exactly and hold for the configured duration',()=>{
  const route={kind:'waypoints',stops:[{...view(45),travel:4,hold:10},{...view(90),travel:2,hold:5}]};
  const t=timeline.build(route,view());assert.equal(t.total,21);
  assert.equal(timeline.at(t,0).view.ra,0);assert.equal(timeline.at(t,2).phase,'travel');
  assert.equal(timeline.at(t,4).view.ra,45);assert.equal(timeline.at(t,13.9).phase,'hold');
  assert.equal(timeline.at(t,14).index,1);assert.equal(timeline.at(t,21).view.ra,90);assert.equal(timeline.at(t,25).phase,'finished');
});

test('recorded routes preserve endpoints and interpolate RA wrap and logarithmic zoom',()=>{
  const r={kind:'recording',track:[{...view(359),t:0,fov:100},{...view(1),t:10,fov:1}]},t=timeline.build(r,view());
  const mid=timeline.at(t,5).view;assert.ok(flight.separation(mid,view(0))<1e-6);assert.ok(Math.abs(mid.fov-10)<1e-8);
  assert.equal(timeline.at(t,10).view.ra,1);assert.equal(timeline.at(t,10).phase,'finished');
});

test('survey changes occur at the actual recorded sample boundary',()=>{
  const r={kind:'recording',track:[{...view(),t:0},{...view(1),t:1,survey:'webb-color'}]},t=timeline.build(r,view());
  assert.equal(timeline.at(t,.9).view.survey,'optical');assert.equal(timeline.at(t,1).view.survey,'webb-color');
});

test('route ordering visits every original stop once and handles RA zero',()=>{
  const stops=[view(60),view(2),view(359),view(15)],order=timeline.nearestOrder(stops,view());
  assert.equal(JSON.stringify(order),JSON.stringify([2,1,3,0]));assert.equal(stops[0].ra,60);
});

test('empty drafts are not playable',()=>{
  assert.equal(timeline.at(timeline.build({kind:'waypoints',stops:[]},view()),0),null);
  assert.equal(timeline.at(timeline.build({kind:'recording',track:[]},view()),0),null);
});

test('rotation takes the short path across equivalent signed full turns',()=>{
  const a={...view(),roll:350},b={...view(),roll:-350};
  assert.equal(timeline.interpolate(a,b,0).roll,350);
  assert.equal(timeline.interpolate(a,b,.5).roll,0);
  assert.equal(timeline.interpolate(a,b,1).roll,-350);
});

test('long guided hops show the actual all-sky context then restore the target survey',()=>{
  const a={...view(0),fov:.1,survey:'webb-color'},b={...view(90),fov:.1,survey:'hubble-color'};
  assert.equal(timeline.interpolate(a,b,.5,true).survey,'optical');
  assert.equal(timeline.interpolate(a,b,1,true).survey,'hubble-color');
  assert.equal(timeline.interpolate(a,b,.5,false).survey,'webb-color');
});
