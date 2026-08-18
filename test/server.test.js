import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createServer } from '../src/server.js';
import { DataSource } from '../src/datasource.js';
import { makeFetch } from './helpers/fakeBinance.js';

const RULES_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'rules.json');

/** Spin up server+client over an in-memory pair and return the connected client. */
async function connect({ shape = 'up', failHosts = [] } = {}) {
  const { fetchImpl, calls } = makeFetch({ shape, failHosts });
  const dataSource = new DataSource({ fetchImpl, ttlMs: 0 });
  const { server } = createServer({ rulesPath: RULES_PATH, dataSource });
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, calls };
}

/** Call a tool and parse the JSON payload back out. */
async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  return { isError: res.isError === true, data: JSON.parse(res.content[0].text) };
}

test('server advertises every documented tool', async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'check_risk', 'get_bias', 'get_candles', 'get_indicators', 'get_macro_snapshot',
    'get_price', 'get_rules', 'scan_watchlist', 'tv_health_check',
  ]);
  for (const t of tools) assert.ok(t.description, `${t.name} needs a description`);
});

test('tv_health_check reports ready when the data source answers', async () => {
  const { client } = await connect();
  const { isError, data } = await call(client, 'tv_health_check');
  assert.equal(isError, false);
  assert.equal(data.ready, true);
  assert.equal(data.rules_loaded, true);
  assert.equal(data.watchlist_size, 8);
  assert.equal(data.data_source_error, null);
});

test('tv_health_check reports not-ready instead of throwing when the source is down', async () => {
  const { client } = await connect({ failHosts: ['api.binance.com'] });
  const { isError, data } = await call(client, 'tv_health_check');
  assert.equal(isError, false, 'health check should still answer');
  assert.equal(data.ready, false);
  assert.match(data.data_source_error, /api\.binance\.com/);
});

test('get_price returns a number', async () => {
  const { client } = await connect();
  const { data } = await call(client, 'get_price', { symbol: 'BINANCE:BTCUSDT' });
  assert.equal(data.price, 64250.10);
  assert.equal(data.symbol, 'BINANCE:BTCUSDT');
});

test('a bare ticker is treated as Binance', async () => {
  const { client } = await connect();
  const { data } = await call(client, 'get_price', { symbol: 'ethusdt' });
  assert.equal(data.symbol, 'BINANCE:ETHUSDT');
});

test('get_indicators returns every indicator named in rules.json', async () => {
  const { client } = await connect();
  const { data } = await call(client, 'get_indicators', { symbol: 'BINANCE:BTCUSDT', timeframe: '1D' });
  const keys = Object.keys(data.indicators);
  for (const k of ['ema_50', 'ema_200', 'rsi_14', 'macd', 'macd_signal', 'macd_histogram', 'volume', 'volume_avg_20']) {
    assert.ok(keys.includes(k), `missing ${k}`);
  }
  assert.ok(data.bars >= 200, 'must pull enough history for the 200 EMA');
  assert.equal(data.indicators.ema_200 === null, false);
});

test('get_bias is bullish on a rising series and bearish on a falling one', async () => {
  const up = await connect({ shape: 'up' });
  const bull = await call(up.client, 'get_bias', { symbol: 'BINANCE:BTCUSDT', timeframe: '4H' });
  assert.equal(bull.data.bias, 'bullish');
  assert.equal(bull.data.bias_conditions.price_above_trend_ema, true);

  const down = await connect({ shape: 'down' });
  const bear = await call(down.client, 'get_bias', { symbol: 'BINANCE:BTCUSDT', timeframe: '4H' });
  assert.equal(bear.data.bias, 'bearish');
});

test('get_bias takes its RSI from the daily even when judging another timeframe', async () => {
  const { client, calls } = await connect();
  await call(client, 'get_bias', { symbol: 'BINANCE:BTCUSDT', timeframe: '4H' });
  const intervals = calls.filter((u) => u.includes('/klines')).map((u) => new URL(u).searchParams.get('interval'));
  assert.ok(intervals.includes('4h'), 'should fetch the requested timeframe');
  assert.ok(intervals.includes('1d'), 'should also fetch the daily for the RSI gate');
});

test('an invalid pair produces a tool error, not a crash', async () => {
  const { client } = await connect();
  const { isError, data } = await call(client, 'get_indicators', { symbol: 'BINANCE:NOSUCHPAIR', timeframe: '1D' });
  assert.equal(isError, true);
  assert.match(data.error, /HTTP 400/);
});

test('an unknown timeframe is rejected with the list of valid ones', async () => {
  const { client } = await connect();
  const { isError, data } = await call(client, 'get_indicators', { symbol: 'BINANCE:BTCUSDT', timeframe: '3Y' });
  assert.equal(isError, true);
  assert.match(data.error, /unsupported timeframe/);
});

test('CRYPTOCAP symbols are refused for candles with a pointer to the right tool', async () => {
  const { client } = await connect();
  const { isError, data } = await call(client, 'get_indicators', { symbol: 'CRYPTOCAP:BTC.D', timeframe: '1D' });
  assert.equal(isError, true);
  assert.match(data.error, /get_macro_snapshot/);
});

test('get_macro_snapshot derives TOTAL3 from dominance', async () => {
  const { client } = await connect();
  const { data } = await call(client, 'get_macro_snapshot');
  assert.equal(data['CRYPTOCAP:BTC.D'], 54.2);
  // 2.4e12 * (1 - 0.67) = 7.92e11
  assert.ok(Math.abs(data['CRYPTOCAP:TOTAL3'] - 2.4e12 * 0.33) < 1e6);
});

test('scan_watchlist covers every pair and timeframe and skips the macro entries', async () => {
  const { client } = await connect();
  const { data } = await call(client, 'scan_watchlist');
  assert.deepEqual(data.timeframes, ['1W', '1D', '4H']);
  // 5 tradeable pairs x 3 timeframes; the 3 CRYPTOCAP entries are skipped.
  assert.equal(data.results.length, 15);
  assert.equal(data.skipped_macro.length, 3);
  assert.equal(data.summary.error, 0);
  assert.equal(data.summary.bullish, 15);
});

test('scan_watchlist keeps going when one symbol fails', async () => {
  const { client } = await connect();
  const { data } = await call(client, 'scan_watchlist', {
    symbols: ['BINANCE:BTCUSDT', 'BINANCE:NOSUCHPAIR'], timeframes: ['1D'],
  });
  assert.equal(data.results.length, 2);
  assert.equal(data.summary.error, 1);
  assert.equal(data.summary.bullish, 1);
});

test('check_risk is wired to the risk_rules in rules.json', async () => {
  const { client } = await connect();
  const { data } = await call(client, 'check_risk', {
    portfolio: 25_000, entry: 100, stop: 95, target: 115,
  });
  assert.equal(data.risk_pct, 1);
  assert.equal(data.risk_amount, 250);
  assert.equal(data.position_size, 50);
  assert.equal(data.rr_ratio, 3);
  assert.equal(data.meets_min_rr, true);
  assert.deepEqual(data.no_trades_during, ['major US CPI', 'FOMC', 'weekend thin liquidity']);
});

test('check_risk rejects a zero-distance stop through the tool boundary', async () => {
  const { client } = await connect();
  const { isError, data } = await call(client, 'check_risk', { portfolio: 1000, entry: 100, stop: 100 });
  assert.equal(isError, true);
  assert.match(data.error, /cannot be equal/);
});

test('get_rules exposes the loaded config including the trend EMA period', async () => {
  const { client } = await connect();
  const { data } = await call(client, 'get_rules');
  assert.equal(data.bias_engine.trend_ema_period, 50);
  assert.equal(data.symbols.length, 8);
});
