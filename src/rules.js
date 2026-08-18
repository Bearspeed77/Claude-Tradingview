// Loads rules.json and turns it into decisions. Pure logic — the caller
// supplies already-computed indicator values.

import { readFileSync } from 'node:fs';

export class RulesError extends Error {}

/**
 * The prose in `bias_criteria` is for a human (and for the model) to read; it
 * is not machine-parseable. `bias_engine` holds the numeric thresholds that
 * actually drive evaluate_bias, so the two can be kept deliberately in sync.
 */
export const DEFAULT_BIAS_ENGINE = {
  trend_ema_period: 50,
  rsi_period: 14,
  rsi_bull_min: 45,
  rsi_bull_max: 70,
  rsi_bear_max: 45,
  rsi_neutral_min: 40,
  rsi_neutral_max: 60,
  require_structure: true,
  structure_pivot_lookback: 2,
};

export function loadRules(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') throw new RulesError(`rules file not found at ${path}`);
    throw new RulesError(`could not parse ${path}: ${err.message}`);
  }
  return normalizeRules(parsed);
}

export function normalizeRules(raw) {
  if (!raw || typeof raw !== 'object') throw new RulesError('rules must be a JSON object');
  const watchlist = raw.watchlist || {};
  const symbols = Object.values(watchlist).flat().filter((s) => typeof s === 'string');
  if (symbols.length === 0) throw new RulesError('rules.watchlist contains no symbols');
  return {
    ...raw,
    watchlist,
    symbols,
    timeframes_to_check: raw.timeframes_to_check?.length ? raw.timeframes_to_check : ['1W', '1D', '4H'],
    bias_engine: { ...DEFAULT_BIAS_ENGINE, ...(raw.bias_engine || {}) },
  };
}

/** "1% of portfolio" -> 1. Also accepts a bare number. */
export function parsePercent(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const m = String(value ?? '').match(/(-?\d+(?:\.\d+)?)\s*%/);
  if (!m) throw new RulesError(`could not read a percentage from "${value}"`);
  return Number(m[1]);
}

/**
 * Decide bias from indicator values. Returns the label plus the individual
 * condition results, so the answer can always be explained rather than
 * asserted — and so a missing input degrades to "unknown" instead of a guess.
 */
export function evaluateBias({ price, trendEma, rsiDaily, structureTrend }, engine = DEFAULT_BIAS_ENGINE) {
  const cfg = { ...DEFAULT_BIAS_ENGINE, ...engine };
  const missing = [];
  if (!Number.isFinite(price)) missing.push('price');
  if (!Number.isFinite(trendEma)) missing.push(`${cfg.trend_ema_period} EMA (not enough history)`);
  if (!Number.isFinite(rsiDaily)) missing.push('daily RSI');
  if (missing.length) {
    return { bias: 'unknown', missing, conditions: {}, engine: cfg };
  }

  const aboveEma = price > trendEma;
  const belowEma = price < trendEma;
  const rsiBull = rsiDaily >= cfg.rsi_bull_min && rsiDaily <= cfg.rsi_bull_max;
  const rsiBear = rsiDaily < cfg.rsi_bear_max;
  const rsiNeutral = rsiDaily >= cfg.rsi_neutral_min && rsiDaily <= cfg.rsi_neutral_max;
  const structureOk = !cfg.require_structure || structureTrend === 'uptrend';
  const structureDown = !cfg.require_structure || structureTrend === 'downtrend';

  const conditions = {
    price_above_trend_ema: aboveEma,
    price_below_trend_ema: belowEma,
    rsi_in_bull_band: rsiBull,
    rsi_below_bear_threshold: rsiBear,
    rsi_in_neutral_band: rsiNeutral,
    structure: structureTrend ?? 'unknown',
  };

  let bias = 'neutral';
  if (aboveEma && rsiBull && structureOk) bias = 'bullish';
  else if (belowEma && rsiBear && structureDown) bias = 'bearish';

  const distancePct = ((price - trendEma) / trendEma) * 100;
  return {
    bias,
    conditions,
    detail: {
      price,
      trend_ema: trendEma,
      trend_ema_period: cfg.trend_ema_period,
      distance_from_ema_pct: Number(distancePct.toFixed(2)),
      rsi_daily: Number(rsiDaily.toFixed(2)),
      structure: structureTrend ?? 'unknown',
    },
    engine: cfg,
  };
}

/**
 * Position sizing from the risk rules. Size comes from the stop distance, not
 * from a fixed notional — risking `max_risk_per_trade` of the portfolio means
 * the loss at the stop equals that amount.
 */
export function checkRisk({ portfolio, entry, stop, target }, riskRules = {}) {
  for (const [name, v] of Object.entries({ portfolio, entry, stop })) {
    if (!Number.isFinite(v) || v <= 0) throw new RulesError(`${name} must be a positive number`);
  }
  if (entry === stop) throw new RulesError('entry and stop cannot be equal');

  const riskPct = parsePercent(riskRules.max_risk_per_trade ?? '1%');
  const minRr = Number(riskRules.min_rr_ratio ?? 2);
  const direction = stop < entry ? 'long' : 'short';
  const riskAmount = portfolio * (riskPct / 100);
  const stopDistance = Math.abs(entry - stop);
  const positionSize = riskAmount / stopDistance;
  const notional = positionSize * entry;

  const result = {
    direction,
    risk_pct: riskPct,
    risk_amount: round(riskAmount),
    stop_distance: round(stopDistance),
    stop_distance_pct: Number(((stopDistance / entry) * 100).toFixed(3)),
    position_size: round(positionSize, 8),
    notional: round(notional),
    notional_pct_of_portfolio: Number(((notional / portfolio) * 100).toFixed(2)),
    min_rr_ratio: minRr,
    no_trades_during: riskRules.no_trades_during ?? [],
  };

  if (Number.isFinite(target)) {
    const reward = Math.abs(target - entry);
    const rr = reward / stopDistance;
    const targetOnRightSide = direction === 'long' ? target > entry : target < entry;
    result.target = target;
    result.reward = round(reward);
    result.rr_ratio = Number(rr.toFixed(2));
    result.meets_min_rr = targetOnRightSide && rr >= minRr;
    if (!targetOnRightSide) {
      result.warning = `target is on the wrong side of entry for a ${direction}`;
    } else if (!result.meets_min_rr) {
      result.warning = `R:R ${rr.toFixed(2)} is below the ${minRr} minimum in rules.json`;
    }
  } else {
    result.rr_ratio = null;
    result.meets_min_rr = null;
    result.note = 'no target supplied, so R:R was not checked';
  }
  return result;
}

function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
