'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const math = require('../static/pixel-mapping-math.js');
const close = (actual, expected, epsilon = 1e-12) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
const midpointFraction = value => (value.mid - value.black) / (value.white - value.black);

test('UMD exports the same public contract to a browser global', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/pixel-mapping-math.js'), 'utf8'), context);
  assert.deepEqual(Object.keys(context.PixelMappingMath), Object.keys(math));
  assert.equal(context.PixelMappingMath.defaults().white, 1);
});

test('defaults are neutral and each caller receives an independent object', () => {
  const first = math.defaults();
  assert.deepEqual(first, {black: 0, mid: .5, white: 1, stretch: 'linear', colormap: 'native',
    reversed: false, saturation: 0, brightness: 0, contrast: 0, red: 0, yellow: 0, green: 0, blue: 0});
  first.black = .3;
  assert.equal(math.defaults().black, 0);
  assert.equal(math.gamma(math.defaults()), 1);
});

test('normalization rejects nonnumeric JSON values and unknown settings', () => {
  for (const input of [null, false, 'bad', 1, [], [0, 1]]) assert.deepEqual(math.normalize(input), math.defaults());
  const bad = JSON.parse('{"black":null,"white":"0.8","mid":[],"reversed":"true",' +
    '"brightness":{},"contrast":false,"saturation":true,"stretch":"<script>",' +
    '"colormap":"unknown","__proto__":{"black":0.9}}');
  assert.deepEqual(math.normalize(bad), math.defaults());
  assert.deepEqual(math.normalize({black: NaN, white: Infinity, mid: -Infinity}), math.defaults());
});

test('cuts remain bounded, ordered and separated for crossed or degenerate inputs', () => {
  for (const black of [-10, 0, .2, .8, 1, 100]) {
    for (const white of [-10, 0, .2, .8, 1, 100]) {
      const value = math.normalize({black, white, mid: 20});
      assert.ok(value.black >= 0 && value.white <= 1);
      assert.ok(value.white - value.black >= 1 / 255 - 1e-15);
      assert.ok(midpointFraction(value) >= .01 - 1e-12);
      assert.ok(midpointFraction(value) <= .93 + 1e-12);
      assert.deepEqual(math.normalize(value), value);
    }
  }
});

test('missing midpoint defaults to the centre of supplied cuts', () => {
  const value = math.normalize({black: .7, white: .9});
  close(value.mid, .8);
  close(math.gamma(value), 1);
});

test('accepted stretches and colormaps survive with clamped display controls', () => {
  for (const stretch of ['linear', 'asinh', 'log', 'sqrt', 'pow2']) {
    for (const colormap of ['native', 'grayscale', 'viridis', 'magma', 'cividis', 'red', 'green', 'blue', 'yellow', 'inferno', 'plasma', 'rainbow']) {
      const value = math.normalize({stretch, colormap, reversed: true, saturation: 2, brightness: -5, contrast: .7});
      assert.equal(value.stretch, stretch);
      assert.equal(value.colormap, colormap);
      assert.equal(value.reversed, true);
      assert.equal(value.saturation, 1);
      assert.equal(value.brightness, -1);
      assert.equal(value.contrast, .7);
    }
  }
  assert.equal(math.normalize({stretch: 'pow'}).stretch, 'linear');
});

test('older profiles gain neutral color controls and malformed intensities are bounded', () => {
  const restored=math.normalize({black:.2,mid:.55,white:.9,colormap:'magma'});
  assert.equal(restored.red,0);assert.equal(restored.yellow,0);assert.equal(restored.green,0);assert.equal(restored.blue,0);
  const previous=math.normalize({red:.3,yellow:-.2,green:.5});
  assert.equal(previous.red,.3);assert.equal(previous.yellow,-.2);assert.equal(previous.green,.5);assert.equal(previous.blue,0);
  const clipped=math.normalize({red:100,yellow:-4,green:'1',blue:10});
  assert.equal(clipped.red,1);assert.equal(clipped.yellow,-1);assert.equal(clipped.green,0);assert.equal(clipped.blue,1);
  assert.equal(math.normalize({blue:-10}).blue,-1);
  for(const name of ['red','yellow','green','blue'])
    for(const value of [NaN,Infinity,-Infinity,null,[],{},true,'1'])assert.equal(math.normalize({[name]:value})[name],0);
});

test('each color control visibly changes dim survey pixels without relying on strong existing hues', () => {
  const input=[.20,.18,.16];
  for(const [name,channels] of [['red',[0]],['yellow',[0,1]],['green',[1]],['blue',[2]]]) {
    for(const amount of [-1,1]) {
      const output=math.colorIntensity(...input,math.normalize({[name]:amount}));
      for(let channel=0;channel<3;channel++) {
        if(channels.includes(channel)) {
          assert.ok(Math.abs(output[channel]-input[channel])*255>30, `${name} must visibly affect dim pixels`);
          close(output[channel],input[channel]*(1+amount));
        } else close(output[channel],input[channel]);
      }
    }
  }
});

test('yellow combines red and green gains while blue remains independent', () => {
  const settings=math.normalize({red:.5,yellow:.5,green:-.5,blue:.25});
  assert.deepEqual(math.channelGains(settings),[2.25,.75,1.25]);
  const output=math.colorIntensity(.2,.4,.4,settings);
  close(output[0],.45);close(output[1],.3);close(output[2],.5);
  assert.deepEqual(math.channelGains(math.normalize({yellow:-1,red:1,green:1,blue:1})),[0,0,2]);
});

test('neutral color settings preserve input pixels and zero stays black', () => {
  assert.deepEqual(math.channelGains(math.defaults()),[1,1,1]);
  for(const rgb of [[0,0,0],[.05,.04,.03],[.5,.5,.5],[1,1,1],[.7,.4,.2]])
    assert.deepEqual(math.colorIntensity(...rgb,math.defaults()),rgb);
  assert.deepEqual(math.colorIntensity(0,0,0,math.normalize({red:1,yellow:1,green:1,blue:1})),[0,0,0]);
});

test('combined extreme color gains clip safely to display range', () => {
  assert.deepEqual(math.colorIntensity(.8,.7,.6,math.normalize({red:1,yellow:1,green:1,blue:1})),[1,1,1]);
  assert.deepEqual(math.colorIntensity(.8,.7,.6,math.normalize({red:-1,yellow:-1,green:-1,blue:-1})),[0,0,0]);
  for(let r=0;r<=1;r+=.1)for(let g=0;g<=1;g+=.1)for(let b=0;b<=1;b+=.1)
    for(const gain of [-1,1])for(const value of math.colorIntensity(r,g,b,math.normalize({red:gain,yellow:gain,green:gain,blue:gain})))
      assert.ok(Number.isFinite(value)&&value>=0&&value<=1);
});

test('gamma maps the chosen relative midpoint to half brightness', () => {
  for (const black of [0, .1, .8]) {
    for (const fraction of [.01, .05, .25, .5, .75, .93]) {
      const white = .95;
      const settings = {black, white, mid: black + fraction * (white - black)};
      const gamma = math.gamma(settings);
      assert.ok(gamma >= .1 && gamma <= 10);
      close(Math.pow(fraction, gamma), .5);
    }
  }
  close(math.gamma({mid: .25}), .5);
  close(math.gamma({mid: Math.sqrt(.5)}), 2);
});

test('moving the midpoint left lowers shader gamma and brightens midtones', () => {
  const brighter = math.gamma({mid: .25});
  const neutral = math.gamma({mid: .5});
  const darker = math.gamma({mid: .75});
  assert.ok(brighter < neutral && darker > neutral);
  assert.ok(Math.pow(.3, brighter) > .3);
  assert.ok(Math.pow(.3, darker) < .3);
});

test('moving cut handles preserves the relative midpoint and other display settings', () => {
  const original = {black: .2, white: .8, mid: .35, stretch: 'asinh', colormap: 'magma'};
  for (const [name, target] of [['black', .1], ['black', .75], ['white', .95], ['white', .21]]) {
    const moved = math.moveHandle(original, name, target);
    close(midpointFraction(moved), .25);
    assert.equal(moved[name], target);
    assert.equal(moved.stretch, 'asinh');
    assert.equal(moved.colormap, 'magma');
  }
  assert.equal(original.mid, .35);
});

test('moving endpoints past one another clamps them without crossing', () => {
  const original = {black: .3, mid: .5, white: .7};
  const black = math.moveHandle(original, 'black', 10);
  close(black.black, .7 - 1 / 255);
  close(black.white, .7);
  close(midpointFraction(black), .5);
  const white = math.moveHandle(original, 'white', -10);
  close(white.white, .3 + 1 / 255);
  close(white.black, .3);
  close(midpointFraction(white), .5);
});

test('moving the midpoint respects actual Aladin gamma limits', () => {
  const low = math.moveHandle(math.defaults(), 'mid', -100);
  const high = math.moveHandle(math.defaults(), 'mid', 100);
  close(low.mid, .01);
  close(high.mid, .93);
  for (const position of [NaN, Infinity, null, [], '0.4']) {
    assert.deepEqual(math.moveHandle(math.defaults(), 'mid', position), math.defaults());
  }
  assert.deepEqual(math.moveHandle(math.defaults(), 'unknown', .3), math.defaults());
});

test('histogram retains byte bins, skips invalid samples and clamps numeric overflows', () => {
  const hist = math.histogram([0, 1 / 255, 128 / 255, 1, -.4, 2, NaN, Infinity, null, '0.5']);
  assert.equal(hist.count, 6);
  assert.equal(hist.bins.length, 256);
  assert.equal(hist.bins[0], 2);
  assert.equal(hist.bins[1], 1);
  assert.equal(hist.bins[128], 1);
  assert.equal(hist.bins[255], 2);
  assert.equal(hist.min, 0);
  assert.equal(hist.max, 1);
  assert.equal(hist.bins.reduce((a, b) => a + b), hist.count);
  assert.equal(math.histogram(new Float32Array([.25, .5, .75])).count, 3);
});

test('histogram accepts generators and empty or malformed input is harmless', () => {
  function* samples() { yield .1; yield NaN; yield .9; }
  assert.equal(math.histogram(samples()).count, 2);
  for (const input of [undefined, null, {}, 3, '', 'abc', [NaN, null]]) {
    const hist = math.histogram(input);
    assert.equal(hist.count, 0);
    assert.equal(hist.min, null);
    assert.equal(hist.max, null);
  }
});

test('auto levels use nearest-rank quantiles and discard isolated outliers', () => {
  const samples = [0, ...Array(200).fill(50 / 255), ...Array(200).fill(200 / 255), 1];
  const hist = math.histogram(samples);
  const levels = math.autoLevels(hist);
  close(levels.black, 50 / 255);
  close(levels.white, 200 / 255);
  close(levels.mid, 125 / 255);
  assert.deepEqual(math.autoLevels(hist, 0, 1), {black: 0, mid: .5, white: 1});
  // The bin counts remain the authority if a saved total is stale.
  assert.deepEqual(math.autoLevels({...hist, count: Infinity}), levels);
  assert.deepEqual(math.autoLevels({...hist, bins: new Uint32Array(hist.bins)}), levels);
});

test('flat, insufficient and percentile-collapsed histograms do not invent contrast', () => {
  for (const samples of [[], [.5], [.5, .5], [.50001, .50002], [...Array(500).fill(.5), 1]]) {
    assert.equal(math.autoLevels(math.histogram(samples)), null);
  }
  const two = math.autoLevels(math.histogram([127 / 255, 128 / 255]), 0, 1);
  close(two.white - two.black, 1 / 255);
  assert.equal(math.autoLevels(math.histogram([0, 1]), .9, .1), null);
  assert.equal(math.autoLevels(math.histogram([0, 1]), .5, .5), null);
});

test('invalid histogram structures and unsafe numeric counts are rejected', () => {
  for (const hist of [null, {}, {bins: []}, {bins: 'x'.repeat(256)}, {bins: Array(256).fill(-1)},
    {bins: Array(256).fill(NaN)}, {bins: Array(256).fill(.5)}, {bins: Array(256).fill(Infinity)},
    {bins: Array(256).fill(Number.MAX_SAFE_INTEGER)}]) {
    assert.equal(math.autoLevels(hist), null);
  }
});
