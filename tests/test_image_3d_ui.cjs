const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../static/image-3d.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '').split('\nlet workspace;')[0];
const tick = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));

function harness() {
  const requests = [], notices = [], scheduled = new Map(); let timerId = 0;
  const request = (url, options) => new Promise((resolve, reject) => requests.push({url, options, resolve, reject}));
  const context = vm.createContext({URL, location: {href: 'http://127.0.0.1:8765/', origin: 'http://127.0.0.1:8765'}, setTimeout, clearTimeout});
  vm.runInContext(source, context);
  context.options = {request, schedule: callback => { const id = ++timerId; scheduled.set(id, callback); return id; }, cancel: id => scheduled.delete(id), notify: job => notices.push(plain(job))};
  const session = vm.runInContext('new Image3DJobSession(options)', context);
  session.setContext('a', true);
  const nextTimer = async () => { const next = scheduled.entries().next().value; assert.ok(next, 'a poll is scheduled'); scheduled.delete(next[0]); await next[1](); };
  return {context, session, requests, notices, scheduled, nextTimer};
}

test('one click submits the chosen local processor and preserves source settings; repeated clicks are deduplicated', async () => {
  const h = harness(), payload = {image_id: 'a', mode: 'trellis', source: 'enhanced', stretch: 'log', resolution: 1024, seed: 42, depth: .35};
  const promise = h.session.start(payload);
  await h.session.start(payload);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, '/api/image-3d/jobs');
  assert.deepEqual(JSON.parse(h.requests[0].options.body), payload);
  h.requests[0].resolve({id: 'j1', state: 'running', progress: 'Generating geometry'}); await promise;
  assert.equal(h.requests[1].url, '/api/image-3d/jobs/j1');
  h.requests[1].resolve({id: 'j1', state: 'complete', result: {id: 'model', image_id: 'a'}}); await tick();
  assert.equal(h.notices.at(-1).result.id, 'model');
  assert.equal(h.session.running(), false); assert.equal(h.scheduled.size, 0);
});

test('default browser timers retain their native receiver rather than the job session', () => {
  const h = harness();
  vm.runInContext(`
    globalThis.timerCalls = [];
    globalThis.setTimeout = function(callback, delay) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      timerCalls.push(['schedule', delay]); return 7;
    };
    globalThis.clearTimeout = function(id) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      timerCalls.push(['cancel', id]);
    };
    const nativeSession = new Image3DJobSession();
    nativeSession.setContext('a', true);
    nativeSession.timer = nativeSession.schedule(() => {}, 5000);
    nativeSession.setContext('a', false);
  `, h.context);
  assert.deepEqual(plain(h.context.timerCalls), [['cancel', null], ['schedule', 5000], ['cancel', 7]]);
});

test('a late response for a different image cannot change the current workspace', async () => {
  const h = harness(), pending = h.session.start({image_id: 'a'});
  h.session.setContext('b', true); const count = h.notices.length;
  h.requests[0].resolve({id: 'j1', state: 'complete', result: {image_id: 'a'}}); await pending;
  assert.equal(h.notices.length, count); assert.equal(h.requests.length, 1);
  h.session.setContext('a', true);
  assert.equal(h.notices.at(-1).state, 'complete');
});

test('closing and reopening while creation is submitted resumes the same job when its id arrives', async () => {
  const h = harness(), pending = h.session.start({image_id: 'a'});
  h.session.setContext('a', false); h.session.setContext('a', true);
  h.requests[0].resolve({id: 'j1', state: 'queued'}); await pending;
  assert.equal(h.requests[1].url, '/api/image-3d/jobs/j1');
  h.requests[1].resolve({id: 'j1', state: 'running'}); await tick();
  assert.equal(h.scheduled.size, 1);
  h.session.setContext('a', false); assert.equal(h.scheduled.size, 0);
});

test('hidden views stop polling and ignore in-flight results until reopened', async () => {
  const h = harness(), pending = h.session.start({image_id: 'a'});
  h.requests[0].resolve({id: 'j1', state: 'running'}); await pending;
  h.session.setContext('a', false); const count = h.notices.length;
  h.requests[1].resolve({id: 'j1', state: 'complete', result: {image_id: 'a'}}); await tick();
  assert.equal(h.notices.length, count); assert.equal(h.scheduled.size, 0);
  h.session.setContext('a', true);
  assert.equal(h.requests.length, 3);
  h.requests[2].resolve({id: 'j1', state: 'complete', result: {image_id: 'a'}}); await tick();
  assert.equal(h.notices.at(-1).state, 'complete');
});

test('three connection errors pause instead of polling forever, and explicit reconnect resumes', async () => {
  const h = harness(), pending = h.session.start({image_id: 'a'});
  h.requests[0].resolve({id: 'j1', state: 'running'}); await pending;
  h.requests[1].reject(Error('Disconnected')); await tick();
  let poll = h.nextTimer(); h.requests[2].reject(Error('Disconnected')); await poll;
  poll = h.nextTimer(); h.requests[3].reject(Error('Disconnected')); await poll;
  assert.equal(h.scheduled.size, 0); assert.equal(h.notices.at(-1).paused, true);
  h.session.resume();
  h.requests[4].resolve({id: 'j1', state: 'complete'}); await tick();
  assert.equal(h.notices.at(-1).state, 'complete'); assert.equal(h.session.running(), false);
});

test('cancellation cannot be overwritten by an older running-status response', async () => {
  const h = harness(), pending = h.session.start({image_id: 'a'});
  h.requests[0].resolve({id: 'j1', state: 'running'}); await pending;
  const cancel = h.session.cancelJob();
  assert.equal(h.requests[2].url, '/api/image-3d/jobs/j1/cancel');
  assert.equal(h.requests[2].options.method, 'POST');
  h.requests[2].resolve({id: 'j1', state: 'cancelled', progress: 'Cancelled'}); await cancel;
  h.requests[1].resolve({id: 'j1', state: 'running'}); await tick();
  assert.equal(h.session.jobs.get('a').job.state, 'cancelled');
  assert.equal(h.notices.at(-1).state, 'cancelled'); assert.equal(h.scheduled.size, 0);
  assert.equal(h.session.running(), false);
});

test('cancelling a previous image never changes a newly selected image', async () => {
  const h = harness(), pending = h.session.start({image_id: 'a'});
  h.requests[0].resolve({id: 'j1', state: 'running'}); await pending;
  const cancel = h.session.cancelJob(); h.session.setContext('b', true); const count = h.notices.length;
  h.requests[2].resolve({id: 'j1', state: 'cancelled'}); await cancel;
  assert.equal(h.notices.length, count); assert.equal(h.session.imageId, 'b');
});

test('missing jobs become terminal and failed submissions can be retried', async () => {
  const h = harness(), pending = h.session.start({image_id: 'a'});
  h.requests[0].reject(Error('Not installed')); await pending;
  assert.equal(h.notices.at(-1).state, 'failed'); assert.equal(h.session.running(), false);
  const retry = h.session.start({image_id: 'a'}); h.requests[1].resolve({id: 'j2', state: 'queued'}); await retry;
  h.requests[2].reject(Object.assign(Error('Gone'), {status: 404})); await tick();
  assert.equal(h.notices.at(-1).state, 'failed'); assert.match(h.notices.at(-1).error, /no longer available/);
  assert.equal(h.scheduled.size, 0);
});

test('polling has a finite budget and reopening retains the reconnect action', async () => {
  const h = harness(); const entry = {imageId: 'a', polls: 360, failures: 0, job: {id: 'slow', state: 'running'}};
  h.session.jobs.set('a', entry); await h.session.poll(entry, h.session.generation);
  assert.equal(h.requests.length, 0); assert.equal(h.notices.at(-1).paused, true);
  h.session.setContext('a', false); h.session.setContext('a', true);
  assert.equal(h.notices.at(-1).paused, true); assert.equal(h.requests.length, 0);
  h.session.resume(); assert.equal(h.requests.length, 1);
});

test('shared model geometry, materials, and texture maps are disposed exactly once', () => {
  const h = harness(), calls = [];
  const texture = {isTexture: true, dispose: () => calls.push('texture')};
  const material = {map: texture, emissiveMap: texture, dispose: () => calls.push('material')};
  const geometry = {dispose: () => calls.push('geometry')};
  h.context.model = {traverse: callback => { callback({geometry, material}); callback({geometry, material: [material]}); }};
  vm.runInContext('disposeModel(model)', h.context);
  assert.deepEqual(calls, ['texture', 'material', 'geometry']);
});

test('model, manifest and source links remain on the local app origin', () => {
  const h = harness();
  assert.equal(vm.runInContext("safeURL('/api/image-3d/model.glb')", h.context), 'http://127.0.0.1:8765/api/image-3d/model.glb');
  for (const url of ['javascript:alert(1)', 'https://elsewhere.example/model.glb', '//elsewhere.example/model.glb', 'data:text/html,test']) {
    h.context.url = url; assert.equal(vm.runInContext('safeURL(url)', h.context), null);
  }
});

test('FITS display renders retain their original-source label', () => {
  const h = harness();
  for (const variant of ['original', 'fits-display-asinh', 'fits-display-linear', 'fits-display-log']) {
    h.context.asset = {source: {variant}};
    assert.equal(vm.runInContext('sourceLabel(asset)', h.context), 'Original source');
  }
  h.context.asset = {source: {variant: 'topaz-output'}};
  assert.equal(vm.runInContext('sourceLabel(asset)', h.context), 'Enhanced source');
});

test('closing an inactive studio does not change focus or other page state', () => {
  const h = harness(); h.context.inactive = {visible: false};
  assert.doesNotThrow(() => vm.runInContext('Image3DWorkspace.prototype.close.call(inactive)', h.context));
  assert.deepEqual(h.context.inactive, {visible: false});
});

test('astronomy camera preserves the source projection while TRELLIS fits its model', () => {
  const h = harness(), position = [], target = [];
  h.context.THREE = {MathUtils: {degToRad: degrees => degrees * Math.PI / 180}};
  h.context.viewer = {
    asset: {mode: 'astronomy'}, modelRadius: 10, model: {rotation: {y: 1}},
    camera: {fov: 60, aspect: 1.5, position: {set: (...values) => position.push(values)}, updateProjectionMatrix() {}},
    controls: {target: {set: (...values) => target.push(values)}, update() {}},
  };
  vm.runInContext('Image3DWorkspace.prototype.resetView.call(viewer)', h.context);
  assert.deepEqual(position.at(-1), [0, 0, 3.4]); assert.deepEqual(target.at(-1), [0, 0, 0]);
  assert.equal(h.context.viewer.camera.fov, 40); assert.equal(h.context.viewer.model.rotation.y, 0);
  assert.ok(Number.isFinite(h.context.viewer.controls.maxAzimuthAngle));
  h.context.viewer.camera.aspect = .5;
  vm.runInContext('Image3DWorkspace.prototype.resetView.call(viewer)', h.context);
  assert.equal(position.at(-1)[2], 6.8);
  h.context.viewer.asset.mode = 'trellis'; h.context.viewer.camera.aspect = 1.5;
  vm.runInContext('Image3DWorkspace.prototype.resetView.call(viewer)', h.context);
  assert.ok(position.at(-1)[2] > 30); assert.equal(h.context.viewer.controls.maxAzimuthAngle, Infinity);
});
