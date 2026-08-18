// Combines the data source, the indicator math, and the rules into the
// answers the MCP tools hand back.

import { ema, rsi, macd, structure, last } from './indicators.js';
import { evaluateBias } from './rules.js';
import { isMacroSymbol } from './datasource.js';

/** Longest lookback we need, plus headroom for EMA convergence. */
export function requiredBars(engine) {
  const longest = Math.max(200, engine.trend_ema_period ?? 50);
  return Math.min(longest * 2 + 50, 1000);
}

/** Indicator snapshot for one symbol on one timeframe. */
export async function computeIndicators(ds, rulesOrEngine, symbol, timeframe) {
  const engine = rulesOrEngine.bias_engine ?? rulesOrEngine;
  const candles = await ds.getCandles(symbol, timeframe, requiredBars(engine));
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);

  const trendEma = ema(closes, engine.trend_ema_period);
  const ema200 = ema(closes, 200);
  const rsiSeries = rsi(closes, engine.rsi_period);
  const macdSeries = macd(closes, 12, 26, 9);
  const struct = structure(highs, lows, engine.structure_pivot_lookback);
  const volAvg = volumes.length >= 20
    ? volumes.slice(-20).reduce((a, b) => a + b, 0) / 20
    : null;

  return {
    symbol,
    timeframe,
    bars: candles.length,
    last_close: last(closes),
    last_bar_time: candles.length ? new Date(candles.at(-1).openTime).toISOString() : null,
    indicators: {
      [`ema_${engine.trend_ema_period}`]: nn(last(trendEma)),
      ema_200: nn(last(ema200)),
      [`rsi_${engine.rsi_period}`]: nn(last(rsiSeries)),
      macd: nn(last(macdSeries.macd)),
      macd_signal: nn(last(macdSeries.signal)),
      macd_histogram: nn(last(macdSeries.histogram)),
      volume: last(volumes),
      volume_avg_20: nn(volAvg),
    },
    structure: struct.trend,
    structure_detail: {
      reason: struct.reason ?? null,
      recent_pivot_highs: struct.pivotHighs.slice(-3).map((p) => p.price),
      recent_pivot_lows: struct.pivotLows.slice(-3).map((p) => p.price),
    },
    // Raw series values the bias step needs, not rounded.
    _raw: { close: last(closes), trendEma: last(trendEma), rsi: last(rsiSeries) },
  };
}

/**
 * Bias for one symbol on one timeframe. The RSI gate is taken from the daily
 * candles regardless of the timeframe being judged, because rules.json states
 * the RSI condition "on daily".
 */
export async function analyzeSymbol(ds, rules, symbol, timeframe) {
  const engine = rules.bias_engine;
  const snapshot = await computeIndicators(ds, rules, symbol, timeframe);

  let rsiDaily = snapshot._raw.rsi;
  if (String(timeframe).toUpperCase() !== '1D') {
    const daily = await computeIndicators(ds, rules, symbol, '1D');
    rsiDaily = daily._raw.rsi;
  }

  const verdict = evaluateBias({
    price: snapshot._raw.close,
    trendEma: snapshot._raw.trendEma,
    rsiDaily,
    structureTrend: snapshot.structure,
  }, engine);

  const { _raw, ...clean } = snapshot;
  return { ...clean, bias: verdict.bias, bias_conditions: verdict.conditions, bias_detail: verdict.detail, bias_missing: verdict.missing ?? null };
}

/**
 * Run the whole watchlist. One symbol failing (delisted pair, thin history)
 * must not sink the scan, so failures are collected per entry.
 */
export async function scanWatchlist(ds, rules, { timeframes, symbols } = {}) {
  const tfs = timeframes?.length ? timeframes : rules.timeframes_to_check;
  const targets = (symbols?.length ? symbols : rules.symbols).filter((s) => !isMacroSymbol(s));
  const skipped = (symbols?.length ? symbols : rules.symbols).filter((s) => isMacroSymbol(s));

  const results = [];
  for (const symbol of targets) {
    for (const timeframe of tfs) {
      try {
        results.push(await analyzeSymbol(ds, rules, symbol, timeframe));
      } catch (err) {
        results.push({ symbol, timeframe, error: err.message });
      }
    }
  }
  return {
    scanned_at: new Date().toISOString(),
    timeframes: tfs,
    results,
    skipped_macro: skipped,
    summary: summarize(results),
  };
}

function summarize(results) {
  const counts = { bullish: 0, bearish: 0, neutral: 0, unknown: 0, error: 0 };
  for (const r of results) {
    if (r.error) counts.error += 1;
    else counts[r.bias] = (counts[r.bias] ?? 0) + 1;
  }
  return counts;
}

/** Round for display, preserving null rather than turning it into 0. */
function nn(v, dp = 4) {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
