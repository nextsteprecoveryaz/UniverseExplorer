'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const PixelMappingMath = require('../static/pixel-mapping-math.js');
const script = fs.readFileSync(path.join(__dirname, '..', 'static', 'pixel-mapping.js'), 'utf8');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
function layer(name, {query = Promise.resolve(), readPixel = () => [128, 128, 128, 255]} = {}) {
  return {
    name, query, readPixel, calls: [], cuts: null,
    setCuts(low, high) { this.cuts = [low, high]; this.calls.push(['cuts', low, high]); },
    setColormap(name, options) { this.colormap = name; this.mapping = options; this.calls.push(['colormap', name]); },
    setGamma(gamma) { this.gamma = gamma; this.calls.push(['gamma', gamma]); },
    setBrightness(value) { this.brightness = value; },
    setContrast(value) { this.contrast = value; },
    setSaturation(value) { this.saturation = value; },
  };
}
function harness({saved, storageError = false} = {}) {
  const nodes = new Map(), frames = new Map(), timers = new Map(), timerDelays = new Map(), storage = new Map(), writes = [], resize = [];
  let serial = 0, currentLayer = null;
  if (saved !== undefined) storage.set('test-pixel-profile', saved);
  function node(selector) {
    if (/^\[data-output=/.test(selector) && !/brightness|contrast|saturation|red|yellow|green/.test(selector)) return null;
    if (!nodes.has(selector)) {
      const dataset = {};
      for (const name of ['handle', 'level', 'setting', 'look']) {
        const match = selector.match(new RegExp(`data-${name}="([^"]+)"`));
        if (match) dataset[name] = match[1];
      }
      const attributes = new Map();
      nodes.set(selector, {
        dataset, style: {}, textContent: '', hidden: false, disabled: false, value: '', checked: false,
        type: dataset.setting === 'reversed' ? 'checkbox' : ['brightness', 'contrast', 'saturation', 'red', 'yellow', 'green'].includes(dataset.setting) ? 'range' : 'select',
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.get(name); },
        getBoundingClientRect() { return {left: 20, top: 0, width: 320, height: 12}; },
        focus() { this.focused = true; }, setPointerCapture(id) { this.capturedPointer = id; },
      });
    }
    return nodes.get(selector);
  }
  const host = {
    hidden: true, children: [], classList: {add() {}}, parentElement: {classList: {toggle() {}}},
    append(child) { this.children.push(child); },
    querySelector: node,
    querySelectorAll(selector) {
      const sets = {
        '[data-handle]': ['black', 'mid', 'white'].map(name => `[data-handle="${name}"]`),
        '[data-level]': ['black', 'mid', 'white'].map(name => `[data-level="${name}"]`),
        '[data-setting]': ['stretch', 'colormap', 'reversed', 'brightness', 'contrast', 'saturation', 'red', 'yellow', 'green'].map(name => `[data-setting="${name}"]`),
        '[data-look]': ['faint', 'crisp'].map(name => `[data-look="${name}"]`),
      };
      return (sets[selector] || []).map(node);
    },
  };
  const imageCanvas = {style: {filter: 'none'}}, catalogCanvas = {style: {filter: 'none'}};
  const sky = {
    getBaseImageLayer: () => currentLayer,
    aladinDiv: {
      style: {filter: 'none'},
      getBoundingClientRect: () => ({width: 800, height: 480}),
      querySelector(selector) { return selector === '.aladin-imageCanvas' ? imageCanvas : catalogCanvas; },
      querySelectorAll(selector) { return selector === '.aladin-imageCanvas' ? [imageCanvas] : [catalogCanvas]; },
    },
  };
  const context = vm.createContext({
    console, PixelMappingMath, Blob, TextEncoder, document: {activeElement: null},
    localStorage: {
      getItem(key) { if (storageError) throw new Error('Storage blocked'); return storage.get(key) || null; },
      setItem(key, value) { if (storageError) throw new Error('Storage blocked'); writes.push({key, value}); storage.set(key, value); },
    },
    requestAnimationFrame(callback) { const id = ++serial; frames.set(id, callback); return id; },
    setTimeout(callback, delay) {
      const id = ++serial; timers.set(id, callback); timerDelays.set(id, delay);
      if (delay === 0) Promise.resolve().then(() => { const pending = timers.get(id); timers.delete(id); timerDelays.delete(id); pending?.(); });
      return id;
    },
    clearTimeout(id) { timers.delete(id); timerDelays.delete(id); },
  });
  vm.runInContext(script, context);
  const Controller = vm.runInContext('PixelMappingController', context);
  const controller = new Controller({host, sky, storageKey: 'test-pixel-profile', onResize: value => resize.push(value)});
  function flushFrames() {
    for (let guard = 0; frames.size && guard < 10; guard += 1) {
      const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback());
    }
  }
  async function advanceTimers(delay) {
    await Promise.resolve();
    for (const [id, callback] of [...timers]) {
      if (timerDelays.get(id) !== delay) continue;
      timers.delete(id); timerDelays.delete(id); callback();
    }
    await Promise.resolve();
  }
  return {
    controller, Controller, host, sky, node, storage, writes, resize, frames, timers, flushFrames, advanceTimers,
    imageCanvas, catalogCanvas, document: context.document,
    setCurrent(next) { currentLayer = next; },
    async bind(key, next) { currentLayer = next; await controller.bind(key, next); },
  };
}

test('normalized display controls become native byte cuts, with valid gamma bounds', async () => {
  const h = harness(), image = layer('2mass'); await h.bind('2mass', image);
  h.controller.change({...PixelMappingMath.defaults(), black: 0.1, white: 0.9, mid: 0.5,
    stretch: 'asinh', colormap: 'magma', reversed: true, saturation: 0.3});
  h.flushFrames();
  assert.deepEqual(image.cuts, [25.5, 229.5]);
  assert.equal(image.gamma, 1); assert.equal(image.colormap, 'magma');
  assert.equal(image.mapping.stretch, 'asinh'); assert.equal(image.mapping.reversed, true);
  assert.equal(image.saturation, 0);
  assert.ok(h.imageCanvas.style.filter.includes('saturate(1.3)'));
  for (const mid of [-100, 100]) {
    h.controller.change({...PixelMappingMath.defaults(), mid}); h.flushFrames();
    assert.ok(Number.isFinite(image.gamma) && image.gamma >= 0.1 && image.gamma <= 10);
  }
});

test('each survey retains independent settings across switches and controller reloads', async () => {
  const h = harness(), infrared = layer('2mass'), optical = layer('optical');
  await h.bind('2mass', infrared);
  h.controller.change({...PixelMappingMath.defaults(), black: 0.2, mid: 0.55, colormap: 'viridis'}); h.flushFrames();
  const infraredSettings = JSON.stringify(h.controller.settings);
  await h.bind('optical', optical);
  assert.equal(h.controller.settings.black, 0); assert.deepEqual(optical.cuts, [0, 255]);
  h.controller.change({...PixelMappingMath.defaults(), white: 0.8, mid: 0.4, contrast: 0.2}); h.flushFrames();
  const opticalSettings = JSON.stringify(h.controller.settings);
  await h.bind('2mass', infrared); assert.equal(JSON.stringify(h.controller.settings), infraredSettings);
  const restored = harness({saved: h.storage.get('test-pixel-profile')});
  await restored.bind('optical', layer('optical'));
  assert.equal(JSON.stringify(restored.controller.settings), opticalSettings);
  await restored.bind('2mass', layer('2mass'));
  assert.equal(JSON.stringify(restored.controller.settings), infraredSettings);
});

test('Compare original changes only rendering and keeps saved adjustments intact', async () => {
  const h = harness(), image = layer('2mass'); await h.bind('2mass', image);
  h.controller.change({...PixelMappingMath.defaults(), black: 0.2, white: 0.8, mid: 0.35, brightness: 0.2}); h.flushFrames();
  const settings = JSON.stringify(h.controller.settings), saved = h.storage.get('test-pixel-profile'), count = h.writes.length;
  const adjustedCuts = [...image.cuts], adjustedGamma = image.gamma, adjustedFilter = h.imageCanvas.style.filter;
  h.node('[data-action="original"]').onclick(); h.flushFrames();
  assert.equal(h.controller.original, true); assert.deepEqual(image.cuts, [0, 255]);
  assert.equal(image.gamma, 1); assert.equal(image.brightness, 0);
  assert.equal(h.imageCanvas.style.filter, 'none');
  assert.equal(JSON.stringify(h.controller.settings), settings);
  assert.equal(h.storage.get('test-pixel-profile'), saved); assert.equal(h.writes.length, count);
  h.node('[data-action="original"]').onclick(); h.flushFrames();
  assert.deepEqual(image.cuts, adjustedCuts); assert.equal(image.gamma, adjustedGamma);
  assert.equal(h.imageCanvas.style.filter, adjustedFilter);
  assert.equal(h.writes.length, count);
});

test('a late layer metadata query cannot apply settings to the replacement survey', async () => {
  const pending = deferred(), h = harness();
  const old = layer('2mass', {query: pending.promise}), current = layer('optical');
  h.setCurrent(old); const staleBind = h.controller.bind('2mass', old);
  await h.bind('optical', current);
  h.controller.change({...PixelMappingMath.defaults(), black: 0.3, mid: 0.6}); h.flushFrames();
  const calls = current.calls.length;
  pending.resolve(); await staleBind;
  assert.equal(old.calls.length, 0); assert.equal(current.calls.length, calls);
  assert.equal(h.controller.key, 'optical'); assert.equal(h.controller.layer, current);
  assert.deepEqual(current.cuts, [76.5, 255]);
});

test('metadata readiness waits for actual renderer registration before applying saved settings', async () => {
  const h = harness({saved: JSON.stringify({'2mass': {...PixelMappingMath.defaults(), black: 0.2, mid: 0.6}})});
  const old = layer('old-base'), ready = layer('2mass'); h.setCurrent(old);
  const binding = h.controller.bind('2mass', ready);
  await Promise.resolve();
  assert.equal(ready.calls.length, 0); assert.equal(old.calls.length, 0);
  await h.advanceTimers(80);
  assert.equal(ready.calls.length, 0, 'Resolved metadata alone must not adjust a not-yet-registered image');
  h.setCurrent(ready); await h.advanceTimers(80); await binding;
  assert.deepEqual(ready.cuts, [51, 255]);
  assert.equal(h.controller.layer, ready); assert.equal(old.calls.length, 0);
  assert.equal(h.writes.length, 0, 'Restoring a profile must not rewrite it');
});

test('a newer binding cancels an older wait for renderer registration', async () => {
  const h = harness(), old = layer('2mass'), current = layer('optical');
  const oldBinding = h.controller.bind('2mass', old); await Promise.resolve();
  assert.equal(old.calls.length, 0);
  await h.bind('optical', current);
  const calls = current.calls.length, status = h.node('[data-pm="status"]').textContent;
  await h.advanceTimers(80); await oldBinding;
  assert.equal(old.calls.length, 0); assert.equal(current.calls.length, calls);
  assert.equal(h.controller.key, 'optical'); assert.equal(h.controller.layer, current);
  assert.equal(h.node('[data-pm="status"]').textContent, status);
});

test('renderer readiness has a bounded wait and reports a late survey without modifying another layer', async () => {
  const h = harness(), ready = layer('2mass'), other = layer('unrelated'); h.setCurrent(other);
  let completed = false;
  const binding = h.controller.bind('2mass', ready).then(() => { completed = true; });
  for (let i = 0; i < 200 && !completed; i += 1) await h.advanceTimers(80);
  assert.equal(completed, true, 'Unavailable renderer registration must not leave an infinite binding promise');
  await binding;
  assert.equal(ready.calls.length, 0); assert.equal(other.calls.length, 0);
  assert.match(h.node('[data-pm="status"]').textContent, /longer|retry/i);
});

test('queued rendering never adjusts a layer that is no longer the visible base layer', async () => {
  const h = harness(), old = layer('2mass'), current = layer('optical'); await h.bind('2mass', old);
  const calls = old.calls.length;
  h.controller.change({...PixelMappingMath.defaults(), black: 0.1});
  h.setCurrent(current); h.flushFrames();
  assert.equal(old.calls.length, calls); assert.equal(current.calls.length, 0);
  await h.controller.bind('optical', current);
  assert.deepEqual(current.cuts, [0, 255]);
});

test('raw byte pixels preserve valid black pixels and reject missing or transparent pixels', () => {
  const {Controller} = harness();
  assert.equal(Controller.pixelBrightness([0, 0, 0, 255]), 0);
  assert.ok(Math.abs(Controller.pixelBrightness([255, 255, 255, 255]) - 1) < 1e-12);
  assert.ok(Math.abs(Controller.pixelBrightness(new Uint8Array([255, 0, 0, 255])) - 0.2126) < 1e-12);
  assert.equal(Controller.pixelBrightness(128), 128 / 255);
  for (const invalid of [null, undefined, NaN, Infinity, [], [1, 2], [1, NaN, 3], [10, 20, 30, 0]]) {
    assert.equal(Controller.pixelBrightness(invalid), null);
  }
});

test('histogram samples positive pixel centers and auto levels retain other display settings', async () => {
  let reads = 0;
  const h = harness(), image = layer('2mass', {readPixel(x, y) {
    assert.ok(x > 0 && x < 800); assert.ok(y > 0 && y < 480);
    const byte = reads++ % 2 ? 200 : 20; return [byte, byte, byte, 255];
  }});
  await h.bind('2mass', image);
  h.controller.change({...PixelMappingMath.defaults(), stretch: 'asinh', colormap: 'magma', saturation: 0.25}); h.flushFrames();
  await h.controller.sample(true); h.flushFrames();
  assert.ok(reads >= 100); assert.equal(h.controller.histogram.count, reads);
  assert.equal(h.controller.histogram.bins[20], reads / 2); assert.equal(h.controller.histogram.bins[200], reads / 2);
  assert.deepEqual(image.cuts, [20, 200]);
  assert.equal(h.controller.settings.stretch, 'asinh'); assert.equal(h.controller.settings.colormap, 'magma');
  assert.equal(h.controller.settings.saturation, 0.25);
  assert.equal(h.controller.sampling, false); assert.equal(h.node('[data-action="auto"]').disabled, false);
});

test('a stale histogram cannot replace data or apply auto levels after a survey switch', async () => {
  const pending = deferred(), h = harness(); let reads = 0;
  const old = layer('2mass', {readPixel: () => reads++ === 0 ? pending.promise : [240, 240, 240, 255]});
  const current = layer('optical'); await h.bind('2mass', old);
  const staleSample = h.controller.sample(true);
  await h.bind('optical', current);
  const settings = JSON.stringify(h.controller.settings), writes = h.writes.length;
  pending.resolve([10, 10, 10, 255]); await staleSample;
  assert.equal(h.controller.histogram, null); assert.equal(h.controller.key, 'optical');
  assert.equal(JSON.stringify(h.controller.settings), settings); assert.equal(h.writes.length, writes);
  assert.equal(h.node('[data-action="auto"]').disabled, false);
});

test('a changed camera invalidates an in-progress auto-level sample', async () => {
  const pending = deferred(), h = harness(); let reads = 0;
  await h.bind('2mass', layer('2mass', {readPixel: () => reads++ === 0 ? pending.promise : [220, 220, 220, 255]}));
  const staleSample = h.controller.sample(true);
  h.controller.invalidateView();
  pending.resolve([20, 20, 20, 255]); await staleSample;
  assert.equal(h.controller.histogram, null); assert.equal(h.writes.length, 0);
  assert.equal(h.controller.settings.black, 0); assert.equal(h.controller.settings.white, 1);
  assert.equal(h.controller.sampling, false);
});

test('a later histogram request wins over an older sample in the same view', async () => {
  const pending = deferred(), h = harness(); let reads = 0;
  await h.bind('2mass', layer('2mass', {readPixel() {
    reads += 1; if (reads === 1) return pending.promise;
    const byte = reads % 2 ? 180 : 20; return [byte, byte, byte, 255];
  }}));
  const staleSample = h.controller.sample(true);
  await h.controller.sample(true);
  const histogram = h.controller.histogram, settings = JSON.stringify(h.controller.settings), writes = h.writes.length;
  assert.ok(histogram?.count > 32);
  pending.resolve([250, 250, 250, 255]); await staleSample;
  assert.equal(h.controller.histogram, histogram);
  assert.equal(JSON.stringify(h.controller.settings), settings); assert.equal(h.writes.length, writes);
  assert.equal(h.controller.sampling, false);
});

test('an in-progress auto-level sample cannot overwrite a newer manual look', async () => {
  const pending = deferred(), h = harness(); let reads = 0;
  const image = layer('2mass', {readPixel() {
    reads += 1; if (reads === 1) return pending.promise;
    const byte = reads % 2 ? 180 : 20; return [byte, byte, byte, 255];
  }});
  await h.bind('2mass', image);
  const sampling = h.controller.sample(true);
  h.controller.change({...PixelMappingMath.defaults(), black: 0.25, white: 0.9, mid: 0.55, colormap: 'magma'}); h.flushFrames();
  const settings = JSON.stringify(h.controller.settings), writes = h.writes.length, cuts = [...image.cuts];
  pending.resolve([20, 20, 20, 255]); await sampling; h.flushFrames();
  assert.ok(h.controller.histogram.count >= 32, 'The histogram can still show the sampled field');
  assert.equal(JSON.stringify(h.controller.settings), settings);
  assert.equal(h.writes.length, writes); assert.deepEqual(image.cuts, cuts);
  assert.equal(image.colormap, 'magma');
});

test('an in-progress auto-level sample cannot cancel a newer original preview', async () => {
  const pending = deferred(), h = harness(); let reads = 0;
  const image = layer('2mass', {readPixel() {
    reads += 1; if (reads === 1) return pending.promise;
    const byte = reads % 2 ? 180 : 20; return [byte, byte, byte, 255];
  }});
  await h.bind('2mass', image);
  h.controller.change({...PixelMappingMath.defaults(), black: 0.15, mid: 0.4, contrast: 0.3}); h.flushFrames();
  const settings = JSON.stringify(h.controller.settings), saved = h.storage.get('test-pixel-profile'), writes = h.writes.length;
  const sampling = h.controller.sample(true);
  h.node('[data-action="original"]').onclick(); h.flushFrames();
  pending.resolve([20, 20, 20, 255]); await sampling; h.flushFrames();
  assert.ok(h.controller.histogram.count >= 32);
  assert.equal(h.controller.original, true); assert.equal(h.imageCanvas.style.filter, 'none');
  assert.deepEqual(image.cuts, [0, 255]); assert.equal(image.gamma, 1);
  assert.equal(JSON.stringify(h.controller.settings), settings);
  assert.equal(h.storage.get('test-pixel-profile'), saved); assert.equal(h.writes.length, writes);
});

test('empty or flat histograms do not overwrite user adjustments with auto levels', async () => {
  const h = harness(), image = layer('2mass', {readPixel: () => null}); await h.bind('2mass', image);
  h.controller.change({...PixelMappingMath.defaults(), black: 0.15, mid: 0.55}); h.flushFrames();
  const settings = JSON.stringify(h.controller.settings), writes = h.writes.length;
  await h.controller.sample(true);
  assert.equal(h.controller.histogram.count, 0); assert.equal(h.writes.length, writes);
  assert.equal(JSON.stringify(h.controller.settings), settings);
  image.readPixel = () => [50, 50, 50, 255]; await h.controller.sample(true);
  assert.equal(h.writes.length, writes); assert.equal(JSON.stringify(h.controller.settings), settings);
  assert.match(h.node('[data-pm="sample-status"]').textContent, /variation|enough/);
});

test('individual missing projection pixels do not abort the usable histogram', async () => {
  let reads = 0;
  const h = harness(); await h.bind('2mass', layer('2mass', {readPixel() {
    reads += 1; if (reads % 3 === 0) throw new Error('Outside projection');
    return [100, 100, 100, 255];
  }}));
  await h.controller.sample();
  assert.ok(reads > 3); assert.ok(h.controller.histogram?.count > 0);
  assert.equal(h.controller.histogram.count, reads - Math.floor(reads / 3));
  assert.equal(h.controller.sampling, false);
});

test('auto levels refuse sparse coverage even when its few pixels have contrast', async () => {
  let reads = 0;
  const h = harness(); await h.bind('2mass', layer('2mass', {readPixel() {
    reads += 1; return reads === 1 ? [10, 10, 10, 255] : reads === 2 ? [230, 230, 230, 255] : null;
  }}));
  await h.controller.sample(true);
  assert.equal(h.controller.histogram.count, 2);
  assert.equal(h.writes.length, 0); assert.equal(h.controller.settings.black, 0);
  assert.match(h.node('[data-pm="sample-status"]').textContent, /enough|pixels|coverage|load/i);
});

test('midtone settings and plotted curve use the native pow(value, gamma) direction', async () => {
  const h = harness(), image = layer('2mass'); await h.bind('2mass', image);
  h.controller.change({...PixelMappingMath.defaults(), mid: 0.25}); h.flushFrames();
  assert.ok(Math.abs(image.gamma - 0.5) < 1e-12, 'A lower midpoint must brighten with gamma below one');
  const curve = h.node('[data-pm="curve"]').getAttribute('d');
  const midpoint = curve.match(/L64 ([\d.]+)/);
  assert.ok(midpoint); assert.ok(Math.abs(Number(midpoint[1]) - 56) < 1e-10, 'Input 0.25 should render at half brightness');
  h.controller.change({...PixelMappingMath.defaults(), mid: Math.sqrt(0.5)}); h.flushFrames();
  assert.ok(Math.abs(image.gamma - 2) < 1e-12, 'A higher midpoint must darken with gamma above one');
});

test('storage failure leaves usable session controls and reports their persistence limit', async () => {
  const h = harness({storageError: true}), image = layer('2mass'); await h.bind('2mass', image);
  h.controller.change({...PixelMappingMath.defaults(), black: 0.1}); h.flushFrames();
  assert.deepEqual(image.cuts, [25.5, 255]);
  assert.equal(h.controller.persistent, false);
  assert.match(h.node('[data-pm="status"]').textContent, /Session|unavailable/);
});

test('numeric and keyboard controls enforce level ordering and end original preview', async () => {
  const h = harness(), image = layer('2mass'); await h.bind('2mass', image);
  h.node('[data-action="original"]').onclick();
  const input = h.node('[data-level="black"]'); input.value = '255'; input.valueAsNumber = 255; input.onchange();
  assert.equal(h.controller.original, false);
  assert.ok(h.controller.settings.black < h.controller.settings.mid);
  assert.ok(h.controller.settings.mid < h.controller.settings.white);
  const handle = h.node('[data-handle="white"]'); let prevented = false;
  handle.onkeydown({key: 'Home', shiftKey: false, preventDefault() { prevented = true; }}); h.flushFrames();
  assert.equal(prevented, true); assert.ok(image.cuts[1] > image.cuts[0]);
  const prior = JSON.stringify(h.controller.settings); input.value = ''; input.valueAsNumber = NaN; input.onchange();
  assert.equal(JSON.stringify(h.controller.settings), prior);
});

test('positive and negative color grading filters only imagery and keeps native grading neutral', async () => {
  const h = harness(), image = layer('2mass');
  h.catalogCanvas.style.filter = 'opacity(0.8)'; h.sky.aladinDiv.style.filter = 'opacity(0.9)';
  await h.bind('2mass', image);
  h.controller.change({...PixelMappingMath.defaults(), brightness: 0.3, contrast: 0.4, saturation: 0.5}); h.flushFrames();
  assert.equal(h.imageCanvas.style.filter, 'brightness(1.3) contrast(1.4) saturate(1.5)');
  assert.equal(image.brightness, 0); assert.equal(image.contrast, 0); assert.equal(image.saturation, 0);
  h.controller.change({...PixelMappingMath.defaults(), brightness: -0.3, contrast: -0.4, saturation: -0.5}); h.flushFrames();
  assert.equal(h.imageCanvas.style.filter, 'brightness(0.7) contrast(0.6) saturate(0.5)');
  assert.equal(image.brightness, 0); assert.equal(image.contrast, 0); assert.equal(image.saturation, 0);
  assert.equal(h.catalogCanvas.style.filter, 'opacity(0.8)', 'Pointing/catalogue overlays must retain their own appearance');
  assert.equal(h.sky.aladinDiv.style.filter, 'opacity(0.9)', 'Filtering the container would also change overlays and controls');
});

test('Reset clears the imagery filter and saves neutral settings for only the active survey', async () => {
  const h = harness(), image = layer('2mass'); await h.bind('2mass', image);
  h.controller.change({...PixelMappingMath.defaults(), black: 0.1, mid: 0.3, brightness: 0.2, contrast: 0.2}); h.flushFrames();
  assert.notEqual(h.imageCanvas.style.filter, 'none');
  assert.ok(h.host.children.includes(h.node('.pm-actions')), 'Reset and Compare must stay outside the scrolling controls');
  h.node('[data-action="reset"]').onclick(); h.flushFrames();
  assert.equal(h.imageCanvas.style.filter, 'none'); assert.deepEqual(image.cuts, [0, 255]);
  assert.equal(image.gamma, 1); assert.equal(h.controller.original, false);
  const stored = JSON.parse(h.storage.get('test-pixel-profile'));
  assert.deepEqual(stored['2mass'], PixelMappingMath.defaults());
  assert.equal(stored.optical, undefined);
});

test('a native rendering error keeps user settings and recovers when the layer becomes usable', async () => {
  const h = harness(), image = layer('2mass'); await h.bind('2mass', image);
  const setCuts = image.setCuts; image.setCuts = () => { throw new Error('Renderer not ready'); };
  h.controller.change({...PixelMappingMath.defaults(), black: 0.2, contrast: 0.3}); h.flushFrames();
  assert.match(h.node('[data-pm="status"]').textContent, /loading|Try/i);
  assert.equal(h.controller.settings.black, 0.2);
  assert.equal(JSON.parse(h.storage.get('test-pixel-profile'))['2mass'].contrast, 0.3);
  image.setCuts = setCuts; h.controller.apply();
  assert.deepEqual(image.cuts, [51, 255]);
  assert.equal(h.imageCanvas.style.filter, 'brightness(1) contrast(1.3) saturate(1)');
  assert.match(h.node('[data-pm="status"]').textContent, /Saved/);
});

test('pointer dragging follows the captured pointer, clamps levels, and stops on cancellation', async () => {
  const h = harness(), image = layer('2mass'); await h.bind('2mass', image);
  const handle = h.node('[data-handle="black"]'); let prevented = false;
  handle.onpointerdown({button: 0, pointerId: 7, clientX: 84, preventDefault() { prevented = true; }});
  assert.equal(prevented, true); assert.equal(handle.focused, true); assert.equal(handle.capturedPointer, 7);
  assert.equal(h.controller.settings.black, 0.2);
  handle.onpointermove({pointerId: 8, clientX: 200}); assert.equal(h.controller.settings.black, 0.2);
  handle.onpointermove({pointerId: 7, clientX: 148}); h.flushFrames();
  assert.equal(h.controller.settings.black, 0.4); assert.equal(image.cuts[0], 102);
  handle.onpointercancel(); handle.onpointermove({pointerId: 7, clientX: 250});
  assert.equal(h.controller.settings.black, 0.4); assert.equal(h.controller.drag, null);
  const white = h.node('[data-handle="white"]');
  white.onpointerdown({button: 0, pointerId: 9, clientX: -100, preventDefault() {}}); h.flushFrames();
  assert.ok(image.cuts[1] > image.cuts[0]);
  white.onlostpointercapture(); assert.equal(h.controller.drag, null);
});

test('numeric entry previews without replacing active text and commits the clamped value on blur', async () => {
  const h = harness(), image = layer('2mass'); await h.bind('2mass', image);
  const input = h.node('[data-level="black"]'); h.document.activeElement = input;
  input.value = '25'; input.valueAsNumber = 25; input.oninput(); h.flushFrames();
  assert.equal(input.value, '25', 'Typing must not replace partial input with a formatted number');
  assert.equal(image.cuts[0], 25);
  input.value = ''; input.valueAsNumber = NaN; input.oninput();
  assert.equal(input.value, ''); assert.equal(image.cuts[0], 25);
  input.onblur(); assert.equal(input.value, '25.0');
  input.value = '999'; input.valueAsNumber = 999; input.onchange(); h.flushFrames();
  assert.ok(image.cuts[0] < image.cuts[1]);
  assert.equal(input.value, (h.controller.settings.black * 255).toFixed(1));
});

function exportHarness() {
  const h=harness(),canvases=[],downloads=[],updates=[],svg=[];
  const source={width:400,height:240,name:'native-image'};
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZAAAAABJRU5ErkJggg==','base64');
  h.sky.getRaDec=()=>[83.82208,-5.39111];h.sky.getFov=()=>[.5,.3];
  h.sky.view={wasm:{update:time=>updates.push(time),canvas:()=>source}};
  h.sky.addColormap=(name,colors)=>{h.sky.palette={name,colors};};
  h.sky.aladinDiv.append=element=>svg.push(element);
  h.document.createElementNS=()=>({attributes:{},setAttribute(name,value){this.attributes[name]=value;},innerHTML:''});
  h.document.createElement=tag=>{
    assert.equal(tag,'canvas');
    const canvas={width:0,height:0,draws:[],labels:[],pixels:new Uint8ClampedArray([128,0,0,255,0,128,0,255])};
    const ctx={filter:'none',drawImage(image,...args){canvas.draws.push({image,args,filter:this.filter});},
      fillRect(){},fillText(text,x,y){canvas.labels.push({text,x,y});},
      measureText(text){return {width:text.length*6};},
      getImageData(){return {data:canvas.pixels};},putImageData(pixels){canvas.pixels=pixels.data;}};
    canvas.getContext=()=>ctx;
    canvas.toBlob=(callback,type)=>{canvas.mime=type;callback(new Blob([png],{type}));};
    canvases.push(canvas);return canvas;
  };
  h.controller.download=(blob,name)=>downloads.push({blob,name});
  return {...h,canvases,downloads,updates,source,svg,png};
}

test('selective controls persist, affect imagery only, and original/reset remove their filter', async () => {
  const h=exportHarness();await h.bind('2mass',layer('2mass'));
  for(const [name,value] of [['red',-.7],['yellow',.5],['green',.3]]) {
    const input=h.node(`[data-setting="${name}"]`);input.value=String(value);input.oninput();
  }
  h.flushFrames();
  assert.match(h.imageCanvas.style.filter,/url\("#pixel-color-\d+"\)/);
  assert.equal(h.catalogCanvas.style.filter,'none');assert.equal(h.sky.aladinDiv.style.filter,'none');
  assert.equal(h.svg.length,1);assert.match(h.svg[0].innerHTML,/color-interpolation-filters="sRGB"/);
  assert.match(h.svg[0].innerHTML,/result="red-graded"/);assert.match(h.svg[0].innerHTML,/result="yellow-graded"/);
  const stored=h.storage.get('test-pixel-profile'),filter=h.imageCanvas.style.filter;
  h.node('[data-action="original"]').onclick();h.flushFrames();assert.equal(h.imageCanvas.style.filter,'none');
  assert.equal(h.storage.get('test-pixel-profile'),stored);
  h.node('[data-action="original"]').onclick();h.flushFrames();assert.equal(h.imageCanvas.style.filter,filter);
  h.node('[data-action="reset"]').onclick();h.flushFrames();assert.equal(h.imageCanvas.style.filter,'none');
  assert.equal(h.controller.settings.red,0);assert.equal(h.controller.settings.green,0);
});

test('yellow palette is registered through the renderer API once and other palettes remain native', async () => {
  const h=exportHarness(),image=layer('2mass');await h.bind('2mass',image);
  h.controller.change({...PixelMappingMath.defaults(),colormap:'yellow'});h.flushFrames();
  assert.equal(h.sky.palette.name,'universe-yellow');assert.equal(h.sky.palette.colors.join(','),'#000000,#ffff00');
  assert.equal(image.colormap,'universe-yellow');
  h.sky.addColormap=()=>{throw Error('Already registered');};h.controller.apply();
  for(const colormap of ['red','green','blue','inferno','plasma','rainbow']) {
    h.controller.change({...PixelMappingMath.defaults(),colormap});h.flushFrames();assert.equal(image.colormap,colormap);
  }
});

test('PNG export redraws and grades imagery, keeps overlays neutral, and adds credit below the map', async () => {
  const h=exportHarness();await h.bind('2mass',layer('2mass'));
  h.controller.change({...PixelMappingMath.defaults(),red:.8,brightness:.2,contrast:.1,saturation:.3});h.flushFrames();
  const saved=h.storage.get('test-pixel-profile'),writes=h.writes.length;
  const pending=h.controller.savePNG();assert.equal(h.node('[data-action="save"]').disabled,true);
  h.flushFrames();await pending;
  assert.deepEqual(h.updates,[0]);assert.equal(h.downloads.length,1);
  const [image,output]=h.canvases;
  assert.equal(image.draws[0].image,h.source);
  assert.equal(image.draws[0].filter,'brightness(1.2) contrast(1.1) saturate(1.3)');
  assert.equal(image.draws[1].image,h.catalogCanvas);assert.equal(image.draws[1].filter,'none');
  assert.ok(image.pixels[0]>128);assert.equal(image.pixels[3],255);assert.equal(image.pixels[5],128);
  assert.equal(output.width,400);assert.ok(output.height>240);assert.equal(output.draws[0].image,image);
  assert.ok(output.labels.every(line=>line.y>=240),'Credit must never cover map pixels');
  assert.ok(output.labels.some(line=>/2MASS/.test(line.text)));
  assert.equal(output.mime,'image/png');assert.equal(h.downloads[0].blob.type,'image/png');
  const png=Buffer.from(await h.downloads[0].blob.arrayBuffer());
  assert.equal(png.subarray(37,41).toString(),'iTXt');
  assert.ok(png.includes(Buffer.from('alasky.cds.unistra.fr/2MASS/Color')));
  assert.ok(png.includes(Buffer.from('"red":0.8')));assert.ok(png.includes(Buffer.from('"width":400')));
  assert.match(h.downloads[0].name,/^universe-2mass-.*\.png$/);
  assert.match(h.node('[data-pm="save-status"]').textContent,/Saved 400/);
  assert.equal(h.node('[data-action="save"]').disabled,false);
  assert.equal(h.storage.get('test-pixel-profile'),saved);assert.equal(h.writes.length,writes);
});

test('original preview PNG uses neutral rendering and retains saved adjustments in metadata', async () => {
  const h=exportHarness();await h.bind('optical',layer('optical'));
  h.controller.change({...PixelMappingMath.defaults(),green:.7,brightness:.4});h.flushFrames();
  h.node('[data-action="original"]').onclick();h.flushFrames();
  const pending=h.controller.savePNG();h.flushFrames();await pending;
  assert.equal(h.canvases[0].draws[0].filter,'none');assert.equal(h.canvases[0].pixels[5],128);
  const text=Buffer.from(await h.downloads[0].blob.arrayBuffer()).toString();
  assert.match(text,/"original_preview":true/);assert.match(text,/"saved_adjustments":\{[^}]+"green":0.7/);
  assert.match(text,/DSS2/);assert.equal(h.controller.settings.green,.7);assert.equal(h.controller.original,true);
});

test('changed view cancels pending PNG instead of attaching stale source information', async () => {
  const h=exportHarness();await h.bind('2mass',layer('2mass'));
  const pending=h.controller.savePNG();h.controller.invalidateView();h.flushFrames();await pending;
  assert.equal(h.downloads.length,0);assert.equal(h.canvases.length,0);
  assert.match(h.node('[data-pm="save-status"]').textContent,/view changed/i);
  assert.equal(h.node('[data-action="save"]').disabled,false);
});

test('blocked or empty native capture is reported and saving can be retried', async () => {
  const h=exportHarness();await h.bind('2mass',layer('2mass'));
  h.sky.view.wasm.canvas=()=>{const error=new Error('tainted');error.name='SecurityError';throw error;};
  let pending=h.controller.savePNG();h.flushFrames();await pending;
  assert.equal(h.downloads.length,0);assert.match(h.node('[data-pm="save-status"]').textContent,/browser blocked/i);
  h.sky.view.wasm.canvas=()=>({width:0,height:0});
  pending=h.controller.savePNG();h.flushFrames();await pending;
  assert.equal(h.downloads.length,0);assert.equal(h.controller.exporting,false);
  h.sky.view.wasm.canvas=()=>h.source;
  pending=h.controller.savePNG();h.flushFrames();await pending;assert.equal(h.downloads.length,1);
});

test('PNG metadata chunk has a valid CRC and preserves every original image chunk', async () => {
  const h=exportHarness(),metadata={source:'https://example.test/source',display:{red:.5},credit:'2MASS · CDS'};
  const blob=await h.Controller.withPngMetadata(new Blob([h.png],{type:'image/png'}),metadata);
  const bytes=Buffer.from(await blob.arrayBuffer()),length=bytes.readUInt32BE(33);
  assert.deepEqual(bytes.subarray(0,33),h.png.subarray(0,33));
  assert.deepEqual(bytes.subarray(33+12+length),h.png.subarray(33));
  assert.equal(bytes.subarray(41,41+length).toString(),'Universe Explorer\0\0\0\0\0'+JSON.stringify(metadata));
  let crc=0xffffffff;
  for(const byte of bytes.subarray(37,41+length)) {
    crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);
  }
  assert.equal(bytes.readUInt32BE(41+length),(crc^0xffffffff)>>>0);
  await assert.rejects(h.Controller.withPngMetadata(new Blob(['not a PNG']),metadata),/invalid PNG/);
});

test('settings JSON exports reproducible values and source coordinates without altering the view', async () => {
  const h=exportHarness();await h.bind('optical',layer('optical'));
  h.controller.change({...PixelMappingMath.defaults(),yellow:-.3,colormap:'yellow'});h.flushFrames();
  const calls=h.controller.layer.calls.length;
  h.node('[data-action="settings"]').onclick();
  const saved=JSON.parse(await h.downloads[0].blob.text());
  assert.equal(saved.display.yellow,-.3);assert.equal(saved.display.colormap,'yellow');
  assert.equal(saved.view.ra_deg,83.82208);assert.equal(saved.survey.id,'optical');
  assert.equal(saved.survey.url,'https://alasky.cds.unistra.fr/DSS/DSSColor');
  assert.equal(h.downloads[0].blob.type,'application/json');assert.equal(h.controller.layer.calls.length,calls);
});
