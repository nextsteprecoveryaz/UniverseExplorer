const test=require('node:test');
const assert=require('node:assert/strict');
const {readMapLayout,changeMapPanel,toggleClearMap,MAP_PANEL_IDS}=require('../static/map-panels.js');

test('clear view restores an individually customized layout without mutating it',()=>{
  const before={minimized:['live','intro','sidebar'],beforeClear:null};
  const clear=toggleClearMap(before);
  assert.deepEqual(clear.minimized,MAP_PANEL_IDS);
  assert.deepEqual(before.minimized,['live','intro','sidebar']);
  assert.deepEqual(toggleClearMap(clear),before);
});
test('a panel can be expanded during clear view while the original layout remains recoverable',()=>{
  const before={minimized:['nearby'],beforeClear:null};
  const peek=changeMapPanel(toggleClearMap(before),'flight',false);
  assert.equal(peek.minimized.includes('flight'),false);
  assert.equal(peek.minimized.includes('objects'),true);
  assert.deepEqual(toggleClearMap(peek),before);
});
test('serialized clear view survives reload, including an empty previous layout',()=>{
  const clean=readMapLayout(null),clear=toggleClearMap(clean);
  const reloaded=readMapLayout(JSON.parse(JSON.stringify(clear)));
  assert.deepEqual(reloaded,clear);
  assert.deepEqual(toggleClearMap(reloaded),clean);
});
test('corrupt preferences and unknown panels cannot break the panel registry',()=>{
  assert.deepEqual(readMapLayout({minimized:['objects','objects',null,'made-up'],beforeClear:'bad'}),{minimized:['objects'],beforeClear:null});
  for(const value of [null,42,'oops',{},[]])assert.deepEqual(readMapLayout(value),{minimized:[],beforeClear:null});
  assert.deepEqual(changeMapPanel(readMapLayout(null),'unknown',true),readMapLayout(null));
});
test('restoring one panel leaves every other minimized panel alone',()=>{
  const layout={minimized:['live','objects','route'],beforeClear:null};
  assert.deepEqual(changeMapPanel(layout,'objects',false).minimized,['live','route']);
  assert.deepEqual(changeMapPanel(layout,'objects',true).minimized,layout.minimized);
});
