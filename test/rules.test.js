import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRules, parsePercent, evaluateBias, checkRisk, RulesError, DEFAULT_BIAS_ENGINE,
} from '../src/rules.js';

const RULES = {
  watchlist: { majors: ['BINANCE:BTCUSDT'], macro: ['CRYPTOCAP:TOTAL'] },
  risk_rules: { max_risk_per_trade: '1% of portfolio', min_rr_ratio: 2 },
};

test('normalizeRules flattens the watchlist and applies engine defaults', () => {
  const r = normalizeRules(RULES);
  assert.deepEqual(r.symbols, ['BINANCE:BTCUSDT', 'CRYPTOCAP:TOTAL']);
  assert.deepEqual(r.timeframes_to_check, ['1W', '1D', '4H']);
  assert.equal(r.bias_engine.trend_ema_period, 50);
});

test('normalizeRules lets rules.json override individual engine fields', () => {
  const r = normalizeRules({ ...RULES, bias_engine: { trend_ema_period: 200 } });
  assert.equal(r.bias_engine.trend_ema_period, 200);
  assert.equal(r.bias_engine.rsi_period, DEFAULT_BIAS_ENGINE.rsi_period);
});

test('normalizeRules rejects an empty watchlist', () => {
  assert.throws(() => normalizeRules({ watchlist: {} }), RulesError);
  assert.throws(() => normalizeRules(null), RulesError);
});

test('parsePercent reads the risk rule string', () => {
  assert.equal(parsePercent('1% of portfolio'), 1);
  assert.equal(parsePercent('0.5%'), 0.5);
  assert.equal(parsePercent(2), 2);
  assert.throws(() => parsePercent('one percent'), RulesError);
});

test('evaluateBias returns bullish only when every condition holds', () => {
  const v = evaluateBias({ price: 110, trendEma: 100, rsiDaily: 60, structureTrend: 'uptrend' });
  assert.equal(v.bias, 'bullish');
  assert.equal(v.conditions.price_above_trend_ema, true);
  assert.equal(v.detail.distance_from_ema_pct, 10);
});

test('evaluateBias will not call bullish on price alone', () => {
  // Above the EMA, but RSI is overbought past the band and structure is unclear.
  const v = evaluateBias({ price: 110, trendEma: 100, rsiDaily: 85, structureTrend: 'unclear' });
  assert.equal(v.bias, 'neutral');
  assert.equal(v.conditions.rsi_in_bull_band, false);
});

test('evaluateBias returns bearish on the mirrored conditions', () => {
  const v = evaluateBias({ price: 90, trendEma: 100, rsiDaily: 35, structureTrend: 'downtrend' });
  assert.equal(v.bias, 'bearish');
});

test('evaluateBias reports unknown rather than guessing when an input is missing', () => {
  const v = evaluateBias({ price: 110, trendEma: null, rsiDaily: 60, structureTrend: 'uptrend' });
  assert.equal(v.bias, 'unknown');
  assert.match(v.missing.join(), /EMA/);
});

test('evaluateBias can ignore structure when the engine says so', () => {
  const v = evaluateBias(
    { price: 110, trendEma: 100, rsiDaily: 60, structureTrend: 'unclear' },
    { require_structure: false }
  );
  assert.equal(v.bias, 'bullish');
});

test('checkRisk sizes the position from the stop distance', () => {
  // 1% of 10,000 = 100 risked; stop is 500 away => 0.2 units.
  const r = checkRisk({ portfolio: 10_000, entry: 50_000, stop: 49_500 }, RULES.risk_rules);
  assert.equal(r.direction, 'long');
  assert.equal(r.risk_amount, 100);
  assert.equal(r.position_size, 0.2);
  assert.equal(r.notional, 10_000);
  assert.equal(r.rr_ratio, null);
});

test('checkRisk computes R:R and flags trades below the minimum', () => {
  const good = checkRisk({ portfolio: 10_000, entry: 50_000, stop: 49_500, target: 51_500 }, RULES.risk_rules);
  assert.equal(good.rr_ratio, 3);
  assert.equal(good.meets_min_rr, true);

  // 500 risk, 1000 reward: exactly the 2.0 minimum, which should pass.
  const atThreshold = checkRisk({ portfolio: 10_000, entry: 50_000, stop: 49_500, target: 51_000 }, RULES.risk_rules);
  assert.equal(atThreshold.rr_ratio, 2);
  assert.equal(atThreshold.meets_min_rr, true);

  const worse = checkRisk({ portfolio: 10_000, entry: 50_000, stop: 49_500, target: 50_250 }, RULES.risk_rules);
  assert.equal(worse.meets_min_rr, false);
  assert.match(worse.warning, /below the 2 minimum/);
});

test('checkRisk detects a short and catches a target on the wrong side', () => {
  const short = checkRisk({ portfolio: 10_000, entry: 50_000, stop: 50_500, target: 49_000 }, RULES.risk_rules);
  assert.equal(short.direction, 'short');
  assert.equal(short.meets_min_rr, true);

  const wrong = checkRisk({ portfolio: 10_000, entry: 50_000, stop: 50_500, target: 51_000 }, RULES.risk_rules);
  assert.equal(wrong.meets_min_rr, false);
  assert.match(wrong.warning, /wrong side/);
});

test('checkRisk rejects nonsense inputs instead of returning Infinity', () => {
  assert.throws(() => checkRisk({ portfolio: 0, entry: 1, stop: 0.5 }, RULES.risk_rules), RulesError);
  assert.throws(() => checkRisk({ portfolio: 100, entry: 50, stop: 50 }, RULES.risk_rules), RulesError);
  assert.throws(() => checkRisk({ portfolio: 100, entry: -1, stop: 0.5 }, RULES.risk_rules), RulesError);
});

test('checkRisk carries the no-trade windows through to the caller', () => {
  const r = checkRisk({ portfolio: 1000, entry: 100, stop: 95 },
    { ...RULES.risk_rules, no_trades_during: ['FOMC'] });
  assert.deepEqual(r.no_trades_during, ['FOMC']);
});
