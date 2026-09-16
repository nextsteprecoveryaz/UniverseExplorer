'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'static', 'telescope-live.js'), 'utf8');
const WEBB_ID = '01K55BZ2519K09YMJTJJHAYJEF';
const HUBBLE_ID = '01K55BZ2519K09YMJTJJHAYJEG';
function observation(id = WEBB_ID, mission = 'webb', overrides = {}) {
  return {id, telescope: mission, target: `${mission} target ${id}`, ra: 83.5, dec: -5.3,
    status: 'Observed', title: 'A real telescope program', start: '2026-09-14T10:00:00Z',
    end: '2026-09-14T11:00:00Z', fetched_at: '2026-09-15T01:00:00Z',
    source_url: `https://spacetelescopelive.org/${mission}?obsId=${id}`, ...overrides};
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
function harness(handler) {
  const elements = new Map(), requests = [], constructions = [], errors = [], intervals = [];
  const el = id => {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', value: '', checked: false, disabled: false, children: [],
      append(child) { this.children.push(child); }, before() {},
    });
    return elements.get(id);
  };
  const sky = {
    position: [10, 20], fov: 3, projection: 'SIN', moves: [], fields: [], surveys: [], callbacks: {},
    gotoRaDec(ra, dec) { this.position = [ra, dec]; this.moves.push([ra, dec]); },
    setFoV(fov) { this.fov = Math.min(fov, this.projection === 'SIN' ? 180 : 360); this.fields.push(this.fov); },
    setProjection(projection) { this.projection = projection; },
    setImageSurvey(survey) { this.surveys.push(survey); },
    setBaseImageLayer(survey) { return this.setImageSurvey(survey); },
    getRaDec() { return this.position; }, getFov() { return [this.fov]; },
    addCatalog(catalog) { this.catalog = catalog; }, on(event, callback) { this.callbacks[event] = callback; },
  };
  const explorer = {
    position: [185, 30], fov: 20, survey: 'optical', projection: 'AIT',
    gotoRaDec() { assert.fail('The telescope map moved the main explorer'); },
    setFoV() { assert.fail('The telescope map zoomed the main explorer'); },
    setImageSurvey() { assert.fail('The telescope map changed the main explorer survey'); },
    setProjection() { assert.fail('The telescope map changed the main explorer projection'); },
  };
  const markers = {sources: [], removeAll() { this.sources = []; }, addSources(rows) { this.sources.push(...rows); }};
  const context = vm.createContext({
    console, URL, Event,
    window: {dispatchEvent() {}},
    document: {hidden: false, createElement: tag => ({tag,setAttribute() {}})},
    setInterval(callback) { intervals.push(callback); return intervals.length; },
    showPage() {}, busy: (_button, _label, action) => action(), failure: error => errors.push(error),
    $: el, date: value => String(value || ''),
    state: {sky: explorer, page: 'telescope-live', config: {surveys: [
      {id: '2mass', name: '2MASS infrared', url: 'P/2MASS/color'},
      {id: 'optical', name: 'DSS2 optical', url: 'P/DSS2/color'},
    ]}},
    atlasSurveyURL: survey => survey.url,
    A: {
      init: Promise.resolve(), source: (ra, dec, data) => ({ra, dec, data}),
      catalog: () => markers,
      aladin(selector, options) { constructions.push({selector, options}); return sky; },
    },
    api: async url => {
      requests.push(url);
      if (handler) return handler(url, requests.length);
      if (url === '/api/live') return {rows: [observation(), observation(HUBBLE_ID, 'hubble')]};
      const parts = url.split('/');
      return observation(parts.at(-1), parts.at(-2));
    },
  });
  vm.runInContext(script, context);
  const live = vm.runInContext('telescopeLive', context);
  live.sky = sky; live.markers = markers;
  return {context, live, sky, explorer, markers, el, requests, constructions, errors, intervals};
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('pixel mapping toolbar button closes the panel and reopens it after dismissal', () => {
  const h=harness(); let toggle;
  h.el('#telescope-live-fullscreen').before=button=>{toggle=button;};
  h.live.mapping={host:{hidden:false},setOpen(open){this.host.hidden=!open;}};
  h.context.initTelescopeLive();
  toggle.onclick(); assert.equal(h.live.mapping.host.hidden,true);
  toggle.onclick(); assert.equal(h.live.mapping.host.hidden,false);
});

test('opening creates one independent Aladin viewer with the official default projection', async () => {
  const h = harness();
  h.live.sky = null;
  await Promise.all([h.context.openTelescopeLive(), h.context.openTelescopeLive()]);
  assert.equal(h.constructions.length, 1);
  assert.equal(h.constructions[0].selector, '#telescope-live-sky');
  assert.equal(h.constructions[0].options.survey, 'P/2MASS/color');
  assert.equal(h.constructions[0].options.projection, undefined);
  assert.notEqual(h.live.sky, h.explorer);
  assert.equal(h.context.state.sky, h.explorer);
  const requests = h.requests.length;
  await h.context.openTelescopeLive();
  assert.equal(h.constructions.length, 1);
  assert.equal(h.requests.length, requests, 'Reopening must preserve the chosen observation');
});

test('mission loading uses the official background surveys and preserves the explorer', async () => {
  const h = harness();
  await h.context.telescopeLiveLoad('webb');
  assert.equal(h.sky.surveys.at(-1), 'P/2MASS/color');
  assert.equal(h.live.observation.id, WEBB_ID);
  assert.deepEqual(h.sky.position, [83.5, -5.3]);
  assert.equal(h.sky.fov, 0.5);
  assert.match(h.el('#telescope-live-note').textContent, /ground-based survey/);
  await h.context.telescopeLiveLoad('hubble');
  assert.equal(h.sky.surveys.at(-1), 'P/DSS2/color');
  assert.equal(h.live.observation.id, HUBBLE_ID);
  assert.equal(h.markers.sources.length, 1);
  assert.equal(h.context.state.sky, h.explorer);
  assert.deepEqual(h.explorer.position, [185, 30]);
  assert.equal(h.explorer.fov, 20);
});

test('all-sky uses the full 360-degree projection and returning restores the target view', async () => {
  const h = harness(); h.context.initTelescopeLive();
  await h.context.telescopeLiveLoad('webb');
  assert.equal(h.sky.projection, 'SIN'); assert.equal(h.sky.fov, 0.5);
  h.el('#telescope-live-all').onclick();
  assert.equal(h.sky.projection, 'AIT');
  assert.equal(h.sky.fov, 360, 'Switch projection before setting FoV so SIN does not clip it at 180');
  await h.context.telescopeLiveLoad('webb', null, {background: true});
  assert.equal(h.sky.projection, 'AIT'); assert.equal(h.sky.fov, 360);
  h.el('#telescope-live-target-button').onclick();
  assert.equal(h.sky.projection, 'SIN'); assert.equal(h.sky.fov, 0.5);
  assert.deepEqual(h.sky.position, [83.5, -5.3]);
  assert.equal(h.context.state.sky, h.explorer);
  assert.deepEqual(h.explorer.position, [185, 30]);
  assert.equal(h.explorer.fov, 20); assert.equal(h.explorer.projection, 'AIT');
});

test('official links resolve to validated mission and observation ID', () => {
  const h = harness();
  const webb = h.context.telescopeLiveLink(`https://spacetelescopelive.org/webb?obsId=${WEBB_ID}`);
  assert.equal(webb.mission, 'webb'); assert.equal(webb.id, WEBB_ID);
  const hubble = h.context.telescopeLiveLink('https://spacetelescopelive.org/hubble/');
  assert.equal(hubble.mission, 'hubble'); assert.equal(hubble.id, null);
});

test('malformed or foreign observation links are rejected before a request', () => {
  const h = harness();
  const invalid = [
    '/webb', '//spacetelescopelive.org/webb', 'not a URL',
    'http://spacetelescopelive.org/webb', 'javascript:alert(1)',
    'https://spacetelescopelive.org.evil.example/webb',
    'https://evil.example/spacetelescopelive.org/webb',
    'https://robbi@spacetelescopelive.org/webb',
    'https://robbi:password@spacetelescopelive.org/webb',
    'https://spacetelescopelive.org:8443/webb',
    'https://spacetelescopelive.org/webb/other',
    'https://spacetelescopelive.org/not-webb',
    'https://spacetelescopelive.org/webb?obsId=../hubble',
    'https://spacetelescopelive.org/webb?obsId=abc',
    `https://spacetelescopelive.org/webb?obsId=${WEBB_ID.toLowerCase()}`,
  ];
  for (const link of invalid) assert.throws(() => h.context.telescopeLiveLink(link), /link|observation ID/, link);
  assert.equal(h.requests.length, 0);
});

test('a late target response cannot overwrite a newer user selection', async () => {
  const old = deferred(), current = deferred();
  const h = harness((_url, count) => count === 1 ? old.promise : current.promise);
  const first = h.context.telescopeLiveLoad('webb', WEBB_ID);
  const second = h.context.telescopeLiveLoad('hubble', HUBBLE_ID);
  current.resolve(observation(HUBBLE_ID, 'hubble', {ra: 42, dec: 10})); await second;
  old.resolve(observation()); await first;
  assert.equal(h.live.mission, 'hubble');
  assert.equal(h.live.observation.id, HUBBLE_ID);
  assert.equal(h.sky.moves.length, 1);
  assert.deepEqual(h.sky.position, [42, 10]);
  assert.equal(h.el('#telescope-live-mission').value, 'hubble');
  assert.equal(h.live.busy, false);
});

test('an obsolete request failure cannot replace newer successful target status', async () => {
  const old = deferred();
  const h = harness((_url, count) => count === 1 ? old.promise : observation(HUBBLE_ID, 'hubble'));
  const pending = h.context.telescopeLiveLoad('webb', WEBB_ID);
  await h.context.telescopeLiveLoad('hubble', HUBBLE_ID);
  const message = h.el('#telescope-live-request').textContent;
  old.reject(new Error('An older request failed')); await pending;
  assert.equal(h.el('#telescope-live-request').textContent, message);
  assert.equal(h.live.observation.id, HUBBLE_ID);
});

test('refreshing the same target preserves free pan and zoom', async () => {
  const h = harness();
  await h.context.telescopeLiveLoad('webb');
  h.sky.gotoRaDec(120, 45); h.sky.setFoV(9);
  const moves = h.sky.moves.length, fields = h.sky.fields.length, surveys = h.sky.surveys.length;
  await h.context.telescopeLiveLoad('webb', null, {background: true});
  assert.equal(h.sky.moves.length, moves); assert.equal(h.sky.fields.length, fields);
  assert.equal(h.sky.surveys.length, surveys);
  assert.deepEqual(h.sky.position, [120, 45]); assert.equal(h.sky.fov, 9);
});

test('following a genuinely new target recenters once and updates its marker', async () => {
  const h = harness((_url, count) => ({rows: [count === 1 ? observation()
    : observation(HUBBLE_ID, 'webb', {ra: 220, dec: -70})]}));
  await h.context.telescopeLiveLoad('webb');
  await h.context.telescopeLiveLoad('webb', null, {background: true});
  assert.equal(h.sky.moves.length, 2);
  assert.deepEqual(h.sky.position, [220, -70]);
  assert.equal(h.sky.fov, 0.5);
  assert.equal(h.markers.sources.length, 1);
  assert.equal(h.markers.sources[0].ra, 220);
});

test('background polling cannot supersede an explicit in-flight target selection', async () => {
  const requested = deferred();
  const h = harness((_url, count) => count === 1 ? requested.promise : {rows: [observation()]});
  const foreground = h.context.telescopeLiveLoad('hubble', HUBBLE_ID);
  await h.context.telescopeLiveLoad('webb', null, {background: true});
  assert.equal(h.requests.length, 1, 'A poll must not invalidate the user request serial');
  assert.equal(h.live.busy, true);
  requested.resolve(observation(HUBBLE_ID, 'hubble')); await foreground;
  assert.equal(h.live.mission, 'hubble'); assert.equal(h.live.observation.id, HUBBLE_ID);
  assert.equal(h.live.busy, false);
});

test('an older completion cannot clear the guard while a newer request is pending', async () => {
  const old = deferred(), current = deferred();
  const h = harness((_url, count) => count === 1 ? old.promise : current.promise);
  const first = h.context.telescopeLiveLoad('webb', WEBB_ID);
  const second = h.context.telescopeLiveLoad('hubble', HUBBLE_ID);
  old.resolve(observation()); await first;
  assert.equal(h.live.busy, true);
  await h.context.telescopeLiveLoad('webb', null, {background: true});
  assert.equal(h.requests.length, 2);
  current.resolve(observation(HUBBLE_ID, 'hubble')); await second;
  assert.equal(h.live.busy, false);
});

test('missing coordinates clear the old marker without inventing a pointing', async () => {
  const h = harness((_url, count) => count === 1 ? observation()
    : observation(HUBBLE_ID, 'hubble', {ra: null, dec: null}));
  await h.context.telescopeLiveLoad('webb', WEBB_ID);
  await h.context.telescopeLiveLoad('hubble', HUBBLE_ID);
  assert.equal(h.sky.moves.length, 1);
  assert.equal(h.markers.sources.length, 0);
  assert.equal(h.el('#telescope-live-target-button').disabled, true);
  assert.match(h.el('#telescope-live-request').textContent, /No target coordinates/);
  for (const bad of [{ra: '10', dec: 2}, {ra: 360, dec: 0}, {ra: -1, dec: 0}, {ra: 20, dec: 91}, {ra: NaN, dec: 0}]) {
    assert.equal(h.context.telescopeLiveCoordinates(bad), false);
  }
});

test('a feed failure preserves the last visible observation and releases the busy guard', async () => {
  const h = harness((_url, count) => count === 1 ? observation() : Promise.reject(new Error('Official feed unavailable')));
  await h.context.telescopeLiveLoad('webb', WEBB_ID);
  await assert.rejects(h.context.telescopeLiveLoad('hubble', HUBBLE_ID), /Official feed unavailable/);
  assert.equal(h.live.observation.id, WEBB_ID); assert.equal(h.live.mission, 'webb');
  assert.equal(h.sky.moves.length, 1); assert.equal(h.sky.surveys.at(-1), 'P/2MASS/color');
  assert.equal(h.el('#telescope-live-mission').value, 'webb');
  assert.match(h.el('#telescope-live-request').textContent, /Official feed unavailable/);
  assert.equal(h.live.busy, false);
});

test('displayed times convert timezone offsets to UTC and handle missing dates', () => {
  const h = harness();
  assert.match(h.context.telescopeLiveUTC('2026-09-14T07:30:00-07:00'), /14 Sept? 2026,? 14:30 UTC/);
  assert.equal(h.context.telescopeLiveUTC(null), 'Not reported');
  assert.equal(h.context.telescopeLiveUTC('invalid date'), 'Not reported');
});

test('the UTC date form requests the selected schedule time and stops following', async () => {
  const h = harness(() => observation(WEBB_ID, 'webb', {previous_id: HUBBLE_ID}));
  h.context.initTelescopeLive();
  h.live.following = true; h.el('#telescope-live-follow').checked = true;
  h.el('#telescope-live-date').value = '2026-09-14T07:30';
  let prevented = false;
  h.el('#telescope-live-date-form').onsubmit({preventDefault() { prevented = true; }});
  await flush();
  assert.equal(prevented, true);
  assert.equal(h.requests[0], '/api/live-at/webb?at=2026-09-14T07%3A30%3A00Z');
  assert.equal(h.live.following, false); assert.equal(h.el('#telescope-live-follow').checked, false);
  assert.match(h.el('#telescope-live-request').textContent, /Schedule near .*07:30 UTC/);
  assert.equal(h.live.observation.id, WEBB_ID);
  assert.equal(h.el('#telescope-live-previous').disabled, false);
  assert.equal(h.el('#telescope-live-next').disabled, true);
});

test('previous and next use server-provided neighbor IDs and stop automatic following', async () => {
  const h = harness(url => observation(url.split('/').at(-1), 'webb', {next_id: WEBB_ID}));
  h.live.observation = observation(WEBB_ID, 'webb', {previous_id: HUBBLE_ID});
  h.live.following = true; h.el('#telescope-live-follow').checked = true;
  h.context.telescopeLiveRender();
  assert.equal(h.el('#telescope-live-previous').disabled, false);
  assert.equal(h.el('#telescope-live-next').disabled, true);
  h.context.telescopeLiveStep('next');
  assert.equal(h.requests.length, 0, 'A missing neighbor must not trigger a current-target request');
  h.context.telescopeLiveStep('previous');
  assert.equal(h.el('#telescope-live-previous').disabled, true);
  assert.equal(h.el('#telescope-live-next').disabled, true);
  await flush();
  assert.equal(h.requests[0], `/api/live/webb/${HUBBLE_ID}`);
  assert.equal(h.live.observation.id, HUBBLE_ID);
  assert.equal(h.live.following, false); assert.equal(h.el('#telescope-live-follow').checked, false);
  assert.equal(h.el('#telescope-live-next').disabled, false);
  h.context.telescopeLiveStep('next'); await flush();
  assert.equal(h.requests[1], `/api/live/webb/${WEBB_ID}`);
  assert.equal(h.live.observation.id, WEBB_ID);
});

test('a slow date lookup cannot overwrite a subsequently selected observation', async () => {
  const schedule = deferred();
  const h = harness((_url, count) => count === 1 ? schedule.promise : observation(HUBBLE_ID, 'hubble'));
  const old = h.context.telescopeLiveLoad('webb', null, {at: '2026-09-14T07:30:00Z'});
  await h.context.telescopeLiveLoad('hubble', HUBBLE_ID);
  schedule.resolve(observation()); await old;
  assert.equal(h.live.observation.id, HUBBLE_ID);
  assert.equal(h.live.mission, 'hubble');
  assert.equal(h.sky.moves.length, 1);
});

test('automatic polling only runs while following in the visible telescope map', async () => {
  const h = harness(); h.context.initTelescopeLive();
  const poll = h.intervals[0];
  poll(); await flush(); assert.equal(h.requests.length, 0);
  h.live.following = true; h.context.document.hidden = true;
  poll(); await flush(); assert.equal(h.requests.length, 0);
  h.context.document.hidden = false; h.context.state.page = 'explore';
  poll(); await flush(); assert.equal(h.requests.length, 0);
  h.context.state.page = 'telescope-live';
  poll(); await flush(); assert.equal(h.requests.length, 1);
});
