#!/usr/bin/env node
// Live end-to-end check: launches the server over stdio exactly the way an MCP
// client does, then exercises the tools against the real market data API.
//
// Run this after installing on a machine with unrestricted network access:
//   npm run smoke

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const transport = new StdioClientTransport({ command: 'node', args: [join(ROOT, 'src', 'server.js')], cwd: ROOT });
const client = new Client({ name: 'smoke', version: '0' }, { capabilities: {} });

let failures = 0;
const show = (label, res) => {
  const body = res.content[0].text;
  const bad = res.isError === true;
  if (bad) failures += 1;
  console.log(`\n${bad ? 'FAIL' : 'ok  '}  ${label}\n${indent(body)}`);
};

await client.connect(transport);

const { tools } = await client.listTools();
console.log(`connected — ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);

const health = await client.callTool({ name: 'tv_health_check', arguments: {} });
show('tv_health_check', health);
const reachable = JSON.parse(health.content[0].text).data_source_reachable;

// Works with no network at all — pure arithmetic over rules.json.
show('check_risk', await client.callTool({
  name: 'check_risk', arguments: { portfolio: 25_000, entry: 64_000, stop: 62_000, target: 70_000 },
}));

if (!reachable) {
  console.log('\nData source unreachable — skipping the live market-data calls.');
  console.log('If this is a sandbox, check the egress policy for api.binance.com.');
} else {
  show('get_price BTCUSDT', await client.callTool({ name: 'get_price', arguments: { symbol: 'BINANCE:BTCUSDT' } }));
  show('get_indicators BTCUSDT 1D', await client.callTool({
    name: 'get_indicators', arguments: { symbol: 'BINANCE:BTCUSDT', timeframe: '1D' },
  }));
  show('get_bias BTCUSDT 4H', await client.callTool({
    name: 'get_bias', arguments: { symbol: 'BINANCE:BTCUSDT', timeframe: '4H' },
  }));
  show('get_macro_snapshot', await client.callTool({ name: 'get_macro_snapshot', arguments: {} }));
}

await client.close();
console.log(failures ? `\n${failures} tool call(s) returned an error.` : '\nAll smoke checks passed.');
process.exit(failures ? 1 : 0);

function indent(text) {
  return text.split('\n').map((l) => `      ${l}`).join('\n');
}
