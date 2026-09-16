/* Pure display-level math. Values are normalized to [0, 1], not byte units. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PixelMappingMath = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const GAP = 1 / 255;
  const MID_MIN = .01;
  const MID_MAX = .93;
  const stretches = new Set(['linear', 'asinh', 'log', 'sqrt', 'pow2']);
  const colormaps = new Set(['native', 'grayscale', 'viridis', 'magma', 'cividis', 'red', 'green', 'blue', 'yellow', 'inferno', 'plasma', 'rainbow']);
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const numberOr = (value, fallback) => finite(value) ? value : fallback;

  function defaults() {
    return {black: 0, mid: .5, white: 1, stretch: 'linear', colormap: 'native',
      reversed: false, saturation: 0, brightness: 0, contrast: 0, red: 0, yellow: 0, green: 0, blue: 0};
  }

  function normalize(input) {
    const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    let black = clamp(numberOr(value.black, 0), 0, 1);
    let white = clamp(numberOr(value.white, 1), 0, 1);
    if (white - black < GAP) {
      white = Math.min(1, black + GAP);
      black = Math.max(0, white - GAP);
    }
    const span = white - black;
    const mid = clamp(numberOr(value.mid, black + span / 2),
      black + MID_MIN * span, black + MID_MAX * span);
    return {black, mid, white,
      stretch: stretches.has(value.stretch) ? value.stretch : 'linear',
      colormap: colormaps.has(value.colormap) ? value.colormap : 'native',
      reversed: value.reversed === true,
      saturation: clamp(numberOr(value.saturation, 0), -1, 1),
      brightness: clamp(numberOr(value.brightness, 0), -1, 1),
      contrast: clamp(numberOr(value.contrast, 0), -1, 1),
      red: clamp(numberOr(value.red, 0), -1, 1),
      yellow: clamp(numberOr(value.yellow, 0), -1, 1),
      green: clamp(numberOr(value.green, 0), -1, 1),
      blue: clamp(numberOr(value.blue, 0), -1, 1)};
  }

  // Display-only RGB gains work even on faint or nearly neutral survey pixels.
  // Yellow raises or lowers red and green together. The SVG preview and PNG export
  // share these gains; settings should be normalized once before image processing.
  function channelGains(settings) {
    const yellow = 1 + settings.yellow;
    return [(1 + settings.red) * yellow, (1 + settings.green) * yellow, 1 + settings.blue];
  }

  function colorIntensity(red, green, blue, settings) {
    const gains = channelGains(settings);
    return [clamp(red * gains[0], 0, 1), clamp(green * gains[1], 0, 1), clamp(blue * gains[2], 0, 1)];
  }

  function gamma(settings) {
    const value = normalize(settings);
    const midpoint = (value.mid - value.black) / (value.white - value.black);
    // Aladin Lite 3.8.2's display transfer is pow(value, gamma). The midpoint is
    // therefore the input that maps to 0.5 (with linear stretch selected).
    return clamp(Math.log(.5) / Math.log(midpoint), .1, 10);
  }

  function moveHandle(settings, name, position) {
    const value = normalize(settings);
    if (!finite(position)) return value;
    const midpoint = (value.mid - value.black) / (value.white - value.black);
    if (name === 'black') {
      value.black = clamp(position, 0, value.white - GAP);
      value.mid = value.black + midpoint * (value.white - value.black);
    } else if (name === 'white') {
      value.white = clamp(position, value.black + GAP, 1);
      value.mid = value.black + midpoint * (value.white - value.black);
    } else if (name === 'mid') {
      value.mid = position;
    }
    return normalize(value);
  }

  function histogram(samples) {
    const bins = Array(256).fill(0);
    let count = 0, min = null, max = null;
    if (!samples || typeof samples[Symbol.iterator] !== 'function') return {bins, count, min, max};
    for (const sample of samples) {
      if (!finite(sample)) continue;
      const value = clamp(sample, 0, 1);
      // Nearest display byte: byte/255 samples land in their original bin.
      bins[Math.round(value * 255)] += 1;
      count += 1;
      min = min === null ? value : Math.min(min, value);
      max = max === null ? value : Math.max(max, value);
    }
    return {bins, count, min, max};
  }

  function autoLevels(hist, lowPercent = .01, highPercent = .995) {
    const bins = hist && hist.bins;
    if ((!Array.isArray(bins) && !ArrayBuffer.isView(bins)) || bins.length !== 256) return null;
    let count = 0, first = -1, last = -1;
    for (let i = 0; i < bins.length; i += 1) {
      if (!Number.isSafeInteger(bins[i]) || bins[i] < 0) return null;
      count += bins[i];
      if (!Number.isSafeInteger(count)) return null;
      if (bins[i]) {
        if (first < 0) first = i;
        last = i;
      }
    }
    // Recount bins instead of trusting a stale or malformed saved count.
    if (count < 2 || first === last) return null;
    const low = clamp(numberOr(lowPercent, .01), 0, 1);
    const high = clamp(numberOr(highPercent, .995), 0, 1);
    if (low >= high) return null;
    const quantile = fraction => {
      const rank = Math.max(1, Math.ceil(fraction * count));
      let seen = 0;
      for (let i = 0; i < bins.length; i += 1) {
        seen += bins[i];
        if (seen >= rank) return i / 255;
      }
      return last / 255;
    };
    const black = quantile(low), white = quantile(high);
    // A constant clipped interval must not turn a flat image into full contrast.
    if (white - black < GAP - Number.EPSILON) return null;
    return {black, mid: (black + white) / 2, white};
  }

  return Object.freeze({defaults, normalize, gamma, moveHandle, histogram, autoLevels, channelGains, colorIntensity});
});
