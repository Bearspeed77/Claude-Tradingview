# tradingview-mcp

An MCP server for the crypto chart-analysis workflow described in
`config/rules.json`: it pulls candles, computes the indicators you care about,
and evaluates your bias and risk rules against them.

## Design note: why this does not attach to TradingView

The setup guide this started from drove the TradingView desktop app over the
Chrome DevTools Protocol (`--remote-debugging-port=9222`). That approach hands
the server full control of a browser session you are logged into — it can read
your account, not just your charts.

Nothing in `rules.json` needs it. Binance spot pairs, 1W/1D/4H candles, RSI,
MACD, EMAs and volume are all available from public endpoints with no
authentication. So this server reads public market data, holds no credentials,
and never touches a logged-in session.

The one thing the CDP approach would buy you is data this cannot reach: your
saved layouts and drawings, paid indicators, and exchange feeds you subscribe
to. If you need those, that is the tradeoff to reopen deliberately.

## Install

```
npm install
npm test          # 46 unit + integration tests, no network required
npm run smoke     # live end-to-end check against the real API
```

Register it with Claude Code by merging `config/mcp-entry.json` into
`~/.claude.json`, replacing `<HOME>` with your home directory:

```json
{
  "mcpServers": {
    "tradingview": { "command": "node", "args": ["<HOME>/tradingview-mcp/src/server.js"] }
  }
}
```

If `mcpServers` already exists, add the `tradingview` key to it rather than
replacing the object.

Point the server at a different rules file with `TRADINGVIEW_MCP_RULES=/path/to/rules.json`.

## Tools

| Tool | What it does |
| --- | --- |
| `tv_health_check` | Config + data source reachability. Reports `ready: false` rather than failing. |
| `get_rules` | The loaded `rules.json`, including resolved defaults. |
| `get_price` | Latest traded price. |
| `get_candles` | Raw OHLCV, oldest first. |
| `get_indicators` | RSI, MACD, trend EMA, 200 EMA, volume, market structure. |
| `get_bias` | Bias for one symbol/timeframe, with every condition shown. |
| `scan_watchlist` | Bias across the whole watchlist and all timeframes. |
| `get_macro_snapshot` | Current CRYPTOCAP TOTAL / TOTAL3 / BTC.D. |
| `check_risk` | Position size and R:R from your risk rules. |

## How bias is decided

`bias_criteria` in `rules.json` is prose — useful for a human and for the
model, but not machine-parseable. The numeric thresholds that actually drive
`get_bias` live in `bias_engine`, so the two are kept deliberately in sync.

A symbol is **bullish** only when all three hold: price above the trend EMA,
daily RSI inside the bull band, and market structure showing higher highs *and*
higher lows. **Bearish** is the mirror. Anything else is **neutral**.

`get_bias` always returns the individual condition results alongside the label,
so you can see *why* — and if an input is unavailable (for example a 200 EMA on
a pair without 200 bars of history) it returns `unknown` with the reason rather
than a number it cannot support.

Two deliberate consequences worth knowing:

- **RSI above 70 is not bullish.** Your band tops out at 70, so a vertical
  melt-up reads as neutral, not as a long signal.
- **The RSI gate always comes from the daily**, even when judging the 4H,
  because `rules.json` specifies the RSI condition "on daily".

### The EMA period

Your original rules had a contradiction: all three `bias_criteria` referenced a
**500 EMA**, while `indicators_i_care_about` listed only the **50** and **200**.
I set `bias_engine.trend_ema_period` to **50**, matching your indicator list —
a 500 EMA on the weekly would need roughly a decade of candles, which most of
these pairs do not have.

If you meant 500, it is a one-line change in `config/rules.json`, and the
`unknown` path means you will get an honest "not enough history" rather than a
silently wrong answer.

## Data sources and their limits

Binance public REST for spot pairs; CoinGecko `/global` for the CRYPTOCAP
aggregates.

The CRYPTOCAP entries are **current values only** — free market-cap history is
not available, so `get_indicators` and `get_bias` refuse them rather than
inventing a series. `scan_watchlist` skips them and lists them under
`skipped_macro`. `TOTAL3` is derived as `TOTAL x (1 - BTC.D - ETH.D)`.

Binance geo-blocks some regions. If `tv_health_check` reports unreachable from
a network you expect to work, that is the first thing to check.

## Testing

`npm test` runs entirely offline: the indicator math is verified against
Wilder's published RSI reference values, and the MCP layer is driven by a real
client over an in-memory transport with a stubbed data source.

`npm run smoke` is the part that needs real network — it launches the server
over stdio the way a client does and calls the live API.

## Not financial advice

This reports what your own rules say about public data. It does not decide
anything for you, and the `no_trades_during` windows in `rules.json` are
surfaced as reminders, not enforced — nothing here checks an economic calendar.
