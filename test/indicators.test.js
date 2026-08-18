import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, macd, structure, last } from '../src/indicators.js';

const close = (v) => assert.ok(Math.abs(v.a - v.b) < v.tol,
  `expected ${v.a} to be within ${v.tol} of ${v.b}`);

test('sma warms up then averages', () => {
  const out = sma([1, 2, 3, 4, 5], 3);
  assert.deepEqual(out.slice(0, 2), [null, null]);
  assert.deepEqual(out.slice(2), [2, 3, 4]);
});

test('sma returns all nulls when series is shorter than the period', () => {
  assert.deepEqual(sma([1, 2], 5), [null, null]);
});

test('ema of a constant series is that constant', () => {
  const out = ema(new Array(50).fill(7), 10);
  assert.equal(out[9], 7);
  close({ a: last(out), b: 7, tol: 1e-12 });
});

test('ema seeds on the sma and then applies the 2/(n+1) multiplier', () => {
  // Seed = mean(1..5) = 3. Next bar: 6*(2/6) + 3*(4/6) = 4.
  const out = ema([1, 2, 3, 4, 5, 6], 5);
  assert.equal(out[4], 3);
  close({ a: out[5], b: 4, tol: 1e-12 });
});

test('ema reacts to a step faster than sma', () => {
  // On a linear ramp both have the same steady-state lag of (n-1)/2, so they
  // land on the same value. The difference shows up on a step change.
  const step = [...new Array(60).fill(100), ...new Array(3).fill(200)];
  const e = last(ema(step, 20));
  const s = last(sma(step, 20));
  assert.ok(e > s, `ema ${e} should exceed sma ${s} after a step up`);
  assert.ok(e < 200 && s < 200, 'neither should have fully caught up yet');
});

// Wilder's reference series (New Concepts in Technical Trading Systems),
// the same data StockCharts publishes RSI(14) values for.
const WILDER = [
  44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245,
  45.8433, 46.0826, 45.8931, 46.0328, 45.6140, 46.2820, 46.2820, 46.0028,
  46.0328, 46.4116, 46.2222, 45.6439, 46.2122, 46.2521, 45.7137, 46.4515,
  45.7835, 45.3548, 44.0288, 44.1783, 44.2181, 44.5672, 43.4205, 42.6628,
  43.1314,
];

test('rsi matches published Wilder reference values', () => {
  const out = rsi(WILDER, 14);
  for (let i = 0; i < 14; i++) assert.equal(out[i], null, `bar ${i} should be warm-up`);
  close({ a: out[14], b: 70.53, tol: 0.01 });
  close({ a: out[15], b: 66.32, tol: 0.01 });
  close({ a: out[16], b: 66.55, tol: 0.01 });
  close({ a: out[19], b: 57.97, tol: 0.01 });
  close({ a: out[32], b: 37.77, tol: 0.01 });
});

test('rsi is 100 for a series that only rises, and bounded 0..100', () => {
  const rising = Array.from({ length: 40 }, (_, i) => 100 + i);
  assert.equal(last(rsi(rising, 14)), 100);
  const falling = Array.from({ length: 40 }, (_, i) => 100 - i);
  close({ a: last(rsi(falling, 14)), b: 0, tol: 1e-9 });
  for (const v of rsi(WILDER, 14)) {
    if (v !== null) assert.ok(v >= 0 && v <= 100);
  }
});

test('rsi needs more than `period` bars', () => {
  assert.deepEqual(rsi([1, 2, 3], 14), [null, null, null]);
});

test('macd of a constant series is flat zero', () => {
  const { macd: line, signal, histogram } = macd(new Array(80).fill(50));
  close({ a: last(line), b: 0, tol: 1e-9 });
  close({ a: last(signal), b: 0, tol: 1e-9 });
  close({ a: last(histogram), b: 0, tol: 1e-9 });
});

test('macd line is positive while price trends up, and histogram = macd - signal', () => {
  const ramp = Array.from({ length: 100 }, (_, i) => 10 + i);
  const { macd: line, signal, histogram } = macd(ramp);
  assert.ok(last(line) > 0);
  const i = line.length - 1;
  close({ a: histogram[i], b: line[i] - signal[i], tol: 1e-9 });
});

test('macd signal warms up after the macd line, not with the price series', () => {
  const ramp = Array.from({ length: 60 }, (_, i) => i);
  const { macd: line, signal } = macd(ramp);
  const firstLine = line.findIndex((v) => v !== null);
  const firstSignal = signal.findIndex((v) => v !== null);
  assert.equal(firstLine, 25);            // slow EMA(26) defined at index 25
  assert.equal(firstSignal, firstLine + 8); // signal EMA(9) seeded from there
});

// Zigzag with two confirmed pivots per side: highs peak at 12 then 16,
// lows trough at 2 then 3.
const UP_HIGHS = [10, 8, 6, 4, 6, 8, 12, 10, 8, 7, 9, 11, 16, 14, 12, 11, 10];
const UP_LOWS  = [ 8, 6, 4, 2, 4, 6,  9,  7, 5, 3, 5,  7, 12, 10,  8,  7,  6];

test('structure identifies an uptrend from higher highs and higher lows', () => {
  const s = structure(UP_HIGHS, UP_LOWS, 2);
  assert.equal(s.trend, 'uptrend');
  assert.deepEqual(s.pivotHighs.map((p) => p.price), [12, 16]);
  assert.deepEqual(s.pivotLows.map((p) => p.price), [2, 3]);
});

test('structure identifies a downtrend', () => {
  // Time-reversing an uptrend yields a downtrend; pivot detection is symmetric.
  const s = structure([...UP_HIGHS].reverse(), [...UP_LOWS].reverse(), 2);
  assert.equal(s.trend, 'downtrend');
});

test('structure reports unclear rather than guessing on thin data', () => {
  const s = structure([1, 2, 3], [0, 1, 2], 2);
  assert.equal(s.trend, 'unclear');
  assert.match(s.reason, /not enough/);
});

test('last skips trailing nulls and NaN', () => {
  assert.equal(last([1, 2, null]), 2);
  assert.equal(last([null, null]), null);
  assert.equal(last([3, NaN]), 3);
});
