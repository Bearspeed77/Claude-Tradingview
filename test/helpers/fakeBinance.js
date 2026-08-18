// A stand-in for the Binance/CoinGecko REST endpoints, so the server can be
// driven end to end without network access.

/**
 * Deterministic synthetic candles. `shape` controls the trend so tests can
 * assert on bias without depending on live market conditions.
 *
 * The trend is drift plus an oscillation large enough to produce genuine down
 * bars (amplitude/period must exceed the drift). A series that only ever rises
 * pins RSI at exactly 100, which rules.json correctly treats as overbought
 * rather than bullish — so a monotonic ramp cannot test the bullish path.
 */
export function makeCandles(count, shape = 'up', start = 100) {
  const DRIFT = 0.2;
  const AMPLITUDE = 6;
  const PERIOD = 6;
  const priceAt = (i) => {
    const wave = AMPLITUDE * Math.sin(i / PERIOD);
    if (shape === 'up') return start + i * DRIFT + wave;
    if (shape === 'down') return start - i * DRIFT + wave;
    return start + wave; // chop
  };

  const rows = [];
  for (let i = 0; i < count; i++) {
    const close = priceAt(i);
    const open = i === 0 ? close : priceAt(i - 1);
    const high = close + 0.4;
    const low = close - 0.4;
    const openTime = 1_600_000_000_000 + i * 86_400_000;
    rows.push([
      openTime, String(open), String(high), String(low), String(close),
      String(1000 + i), openTime + 86_399_999, '0', 0, '0', '0', '0',
    ]);
  }
  return rows;
}

/** Build a fetch replacement. `calls` records every URL requested. */
export function makeFetch({ shape = 'up', calls = [], failHosts = [] } = {}) {
  const fetchImpl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (failHosts.includes(u.host)) throw new Error(`ECONNREFUSED ${u.host}`);
    if (u.pathname === '/api/v3/ping') return json({});
    if (u.pathname === '/api/v3/klines') {
      const symbol = u.searchParams.get('symbol');
      if (symbol === 'NOSUCHPAIR') {
        return { ok: false, status: 400, text: async () => '{"code":-1121,"msg":"Invalid symbol."}' };
      }
      const limit = Number(u.searchParams.get('limit')) || 500;
      return json(makeCandles(limit, shape));
    }
    if (u.pathname === '/api/v3/ticker/price') {
      return json({ symbol: u.searchParams.get('symbol'), price: '64250.10' });
    }
    if (u.host === 'api.coingecko.com') {
      return json({
        data: {
          total_market_cap: { usd: 2_400_000_000_000 },
          market_cap_percentage: { btc: 54.2, eth: 12.8 },
        },
      });
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };
  return { fetchImpl, calls };
}

function json(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}
