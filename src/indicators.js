// Pure indicator math. No I/O, no network — every function takes numbers and
// returns numbers, so the whole file is testable offline.
//
// All series functions return an array the same length as the input, with
// `null` in the warm-up region where the indicator is not yet defined. Keeping
// the alignment means callers can always index by bar number.

/** Simple moving average. */
export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average, seeded with the SMA of the first `period` bars. */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Relative Strength Index using Wilder's smoothing — the same variant
 * TradingView's built-in RSI uses, so values line up with the chart.
 */
export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * MACD. The signal line is an EMA of the MACD line, which itself only starts
 * once the slow EMA is defined — so the signal EMA is seeded from the first
 * defined MACD bar rather than from the start of the price series.
 */
export function macd(values, fast = 12, slow = 26, signal = 9) {
  const n = values.length;
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (emaFast[i] !== null && emaSlow[i] !== null) macdLine[i] = emaFast[i] - emaSlow[i];
  }
  const firstDefined = macdLine.findIndex((v) => v !== null);
  const signalLine = new Array(n).fill(null);
  const histogram = new Array(n).fill(null);
  if (firstDefined !== -1) {
    const dense = macdLine.slice(firstDefined);
    const denseSignal = ema(dense, signal);
    for (let i = 0; i < dense.length; i++) {
      const at = firstDefined + i;
      signalLine[at] = denseSignal[i];
      if (denseSignal[i] !== null) histogram[at] = macdLine[at] - denseSignal[i];
    }
  }
  return { macd: macdLine, signal: signalLine, histogram };
}

/**
 * Pivot highs/lows: a bar that is the strict extreme of the `lookback` bars on
 * both sides of it. Bars within `lookback` of the series end can never
 * qualify, which is correct — a pivot is not confirmed until it has been
 * bracketed on the right.
 */
export function pivots(highs, lows, lookback = 2) {
  const pivotHighs = [];
  const pivotLows = [];
  for (let i = lookback; i < highs.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (highs[j] >= highs[i]) isHigh = false;
      if (lows[j] <= lows[i]) isLow = false;
    }
    if (isHigh) pivotHighs.push({ index: i, price: highs[i] });
    if (isLow) pivotLows.push({ index: i, price: lows[i] });
  }
  return { pivotHighs, pivotLows };
}

/**
 * Market structure from the last two confirmed pivots on each side.
 * Returns 'uptrend' (higher highs AND higher lows), 'downtrend' (lower highs
 * AND lower lows), or 'unclear' — including when there is not enough data,
 * which is deliberately not treated as a trend signal.
 */
export function structure(highs, lows, lookback = 2) {
  const { pivotHighs, pivotLows } = pivots(highs, lows, lookback);
  if (pivotHighs.length < 2 || pivotLows.length < 2) {
    return { trend: 'unclear', reason: 'not enough confirmed pivots', pivotHighs, pivotLows };
  }
  const [ph1, ph2] = pivotHighs.slice(-2);
  const [pl1, pl2] = pivotLows.slice(-2);
  const higherHigh = ph2.price > ph1.price;
  const higherLow = pl2.price > pl1.price;
  const lowerHigh = ph2.price < ph1.price;
  const lowerLow = pl2.price < pl1.price;
  if (higherHigh && higherLow) return { trend: 'uptrend', higherHigh, higherLow, pivotHighs, pivotLows };
  if (lowerHigh && lowerLow) return { trend: 'downtrend', lowerHigh, lowerLow, pivotHighs, pivotLows };
  return { trend: 'unclear', reason: 'highs and lows disagree', pivotHighs, pivotLows };
}

/** Last non-null value of a series, or null if never defined. */
export function last(series) {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] !== null && series[i] !== undefined && !Number.isNaN(series[i])) return series[i];
  }
  return null;
}
