#!/usr/bin/env node
// TradingView MCP server.
//
// Reads public market data and evaluates it against rules.json. It holds no
// credentials and never attaches to a logged-in TradingView session, so the
// worst case for a bad request is a wrong number, not a compromised account.
//
// stdout is reserved for the MCP protocol — all logging goes to stderr.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { DataSource } from './datasource.js';
import { loadRules, checkRisk } from './rules.js';
import { computeIndicators, analyzeSymbol, scanWatchlist } from './analysis.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_RULES = join(HERE, '..', 'config', 'rules.json');

export function createServer({ rulesPath = process.env.TRADINGVIEW_MCP_RULES || DEFAULT_RULES, dataSource } = {}) {
  const resolvedRules = resolve(rulesPath);
  const rules = loadRules(resolvedRules);
  const ds = dataSource ?? new DataSource();

  const server = new McpServer(
    { name: 'tradingview-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
  const fail = (err) => ({
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: err.message ?? String(err) }, null, 2) }],
  });
  const guard = (fn) => async (args) => {
    try { return ok(await fn(args)); } catch (err) { return fail(err); }
  };

  const symbolArg = z.string().describe('Symbol such as "BINANCE:BTCUSDT" (a bare ticker is assumed to be Binance)');
  const timeframeArg = z.string().describe('Timeframe such as 1W, 1D, or 4H');

  server.registerTool('tv_health_check', {
    title: 'Health check',
    description: 'Verify the server is configured and the market data source is reachable.',
    inputSchema: {},
  }, guard(async () => {
    let source = { reachable: false };
    let error = null;
    try { source = await ds.ping(); } catch (err) { error = err.message; }
    return {
      server: 'tradingview-mcp 0.1.0',
      rules_file: resolvedRules,
      rules_loaded: true,
      watchlist_size: rules.symbols.length,
      timeframes: rules.timeframes_to_check,
      trend_ema_period: rules.bias_engine.trend_ema_period,
      data_source: 'Binance public REST (no credentials)',
      data_source_reachable: source.reachable,
      data_source_latency_ms: source.latency_ms ?? null,
      data_source_error: error,
      ready: source.reachable,
    };
  }));

  server.registerTool('get_rules', {
    title: 'Get rules',
    description: 'Return the loaded rules.json: watchlist, timeframes, bias thresholds and risk rules.',
    inputSchema: {},
  }, guard(async () => rules));

  server.registerTool('get_price', {
    title: 'Get price',
    description: 'Latest traded price for a symbol.',
    inputSchema: { symbol: symbolArg },
  }, guard(({ symbol }) => ds.getPrice(symbol)));

  server.registerTool('get_candles', {
    title: 'Get candles',
    description: 'Raw OHLCV candles, oldest first.',
    inputSchema: {
      symbol: symbolArg,
      timeframe: timeframeArg,
      limit: z.number().int().min(1).max(1000).optional().describe('Number of candles (default 200)'),
    },
  }, guard(async ({ symbol, timeframe, limit }) => {
    const candles = await ds.getCandles(symbol, timeframe, limit ?? 200);
    return { symbol, timeframe, count: candles.length, candles };
  }));

  server.registerTool('get_indicators', {
    title: 'Get indicators',
    description: 'RSI, MACD, trend EMA, 200 EMA, volume and market structure for one symbol and timeframe.',
    inputSchema: { symbol: symbolArg, timeframe: timeframeArg },
  }, guard(async ({ symbol, timeframe }) => {
    const { _raw, ...snapshot } = await computeIndicators(ds, rules, symbol, timeframe);
    return snapshot;
  }));

  server.registerTool('get_bias', {
    title: 'Get bias',
    description: 'Evaluate the bias_criteria in rules.json for one symbol and timeframe, showing which conditions passed.',
    inputSchema: { symbol: symbolArg, timeframe: timeframeArg },
  }, guard(({ symbol, timeframe }) => analyzeSymbol(ds, rules, symbol, timeframe)));

  server.registerTool('scan_watchlist', {
    title: 'Scan watchlist',
    description: 'Run the bias evaluation across the whole watchlist and every configured timeframe.',
    inputSchema: {
      timeframes: z.array(z.string()).optional().describe('Override the timeframes from rules.json'),
      symbols: z.array(z.string()).optional().describe('Override the watchlist symbols'),
    },
  }, guard(({ timeframes, symbols }) => scanWatchlist(ds, rules, { timeframes, symbols })));

  server.registerTool('get_macro_snapshot', {
    title: 'Get macro snapshot',
    description: 'Current CRYPTOCAP TOTAL, TOTAL3 and BTC dominance. Current values only — these aggregates have no free OHLCV history.',
    inputSchema: {},
  }, guard(() => ds.getMacroSnapshot()));

  server.registerTool('check_risk', {
    title: 'Check risk',
    description: 'Position size and R:R for a trade idea, using the risk_rules in rules.json.',
    inputSchema: {
      portfolio: z.number().positive().describe('Total portfolio value in quote currency'),
      entry: z.number().positive().describe('Intended entry price'),
      stop: z.number().positive().describe('Stop loss price'),
      target: z.number().positive().optional().describe('Take profit price; omit to skip the R:R check'),
    },
  }, guard(async (args) => checkRisk(args, rules.risk_rules)));

  return { server, rules, dataSource: ds };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const { server, rules } = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`tradingview-mcp ready — ${rules.symbols.length} symbols, timeframes ${rules.timeframes_to_check.join('/')}`);
  } catch (err) {
    console.error(`tradingview-mcp failed to start: ${err.message}`);
    process.exit(1);
  }
}
