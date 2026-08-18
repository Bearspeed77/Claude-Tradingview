// Market data access. The only file in the server that touches the network.
//
// `fetchImpl` is injected so the whole module can be exercised offline in
// tests; production callers get globalThis.fetch.

const BINANCE = 'https://api.binance.com/api/v3';
const COINGECKO = 'https://api.coingecko.com/api/v3';

/** TradingView-style timeframe -> Binance interval. */
const INTERVALS = {
  '1M': '1M', '1W': '1w', '1D': '1d',
  '12H': '12h', '8H': '8h', '6H': '6h', '4H': '4h', '2H': '2h', '1H': '1h',
  '30M': '30m', '15M': '15m', '5M': '5m', '1M_MIN': '1m',
};

/** CRYPTOCAP aggregates, which have no free OHLCV history. */
const MACRO = new Set(['TOTAL', 'TOTAL2', 'TOTAL3', 'BTC.D', 'ETH.D', 'USDT.D']);

export class UnsupportedSymbolError extends Error {}
export class DataSourceError extends Error {}

/**
 * Split "BINANCE:BTCUSDT" into { exchange, ticker }. A bare "BTCUSDT" is
 * assumed to be Binance, matching how the watchlist is usually written.
 */
export function parseSymbol(symbol) {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) throw new UnsupportedSymbolError('empty symbol');
  const [a, b] = raw.includes(':') ? raw.split(':', 2) : ['BINANCE', raw];
  if (!b) throw new UnsupportedSymbolError(`malformed symbol: ${symbol}`);
  return { exchange: a, ticker: b };
}

/** Map a timeframe label to a Binance interval, or throw. */
export function toInterval(timeframe) {
  const key = String(timeframe || '').trim().toUpperCase();
  const mapped = INTERVALS[key];
  if (!mapped) {
    throw new UnsupportedSymbolError(
      `unsupported timeframe "${timeframe}" (known: ${Object.keys(INTERVALS).join(', ')})`
    );
  }
  return mapped;
}

export function isMacroSymbol(symbol) {
  const { exchange, ticker } = parseSymbol(symbol);
  return exchange === 'CRYPTOCAP' && MACRO.has(ticker);
}

/** Small TTL cache so repeated watchlist scans do not hammer the API. */
class TtlCache {
  constructor(ttlMs) { this.ttlMs = ttlMs; this.map = new Map(); }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) { this.map.delete(key); return undefined; }
    return hit.value;
  }
  set(key, value) { this.map.set(key, { at: Date.now(), value }); }
  clear() { this.map.clear(); }
}

export class DataSource {
  constructor({ fetchImpl = globalThis.fetch, ttlMs = 30_000, timeoutMs = 15_000 } = {}) {
    if (typeof fetchImpl !== 'function') throw new DataSourceError('no fetch implementation available');
    this.fetchImpl = fetchImpl;
    this.cache = new TtlCache(ttlMs);
    this.timeoutMs = timeoutMs;
  }

  async #json(url) {
    const cached = this.cache.get(url);
    if (cached !== undefined) return cached;

    let res;
    try {
      res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new DataSourceError(`request to ${hostOf(url)} failed: ${err.message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new DataSourceError(
        `${hostOf(url)} returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`
      );
    }
    const data = await res.json();
    this.cache.set(url, data);
    return data;
  }

  /**
   * OHLCV candles, oldest first. `limit` should comfortably exceed the longest
   * indicator period — a 200 EMA needs at least 200 bars before it is defined.
   */
  async getCandles(symbol, timeframe, limit = 500) {
    if (isMacroSymbol(symbol)) {
      throw new UnsupportedSymbolError(
        `${symbol} is a CRYPTOCAP aggregate with no free OHLCV history; ` +
        `use get_macro_snapshot for its current value`
      );
    }
    const { exchange, ticker } = parseSymbol(symbol);
    if (exchange !== 'BINANCE') {
      throw new UnsupportedSymbolError(`exchange "${exchange}" is not supported (only BINANCE)`);
    }
    const capped = Math.min(Math.max(Number(limit) || 500, 1), 1000);
    const url = `${BINANCE}/klines?symbol=${encodeURIComponent(ticker)}` +
                `&interval=${toInterval(timeframe)}&limit=${capped}`;
    const rows = await this.#json(url);
    if (!Array.isArray(rows)) throw new DataSourceError(`unexpected klines payload for ${symbol}`);
    return rows.map((r) => ({
      openTime: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
      closeTime: Number(r[6]),
    }));
  }

  /** Latest traded price. */
  async getPrice(symbol) {
    const { exchange, ticker } = parseSymbol(symbol);
    if (exchange !== 'BINANCE') {
      throw new UnsupportedSymbolError(`exchange "${exchange}" is not supported for spot price`);
    }
    const data = await this.#json(`${BINANCE}/ticker/price?symbol=${encodeURIComponent(ticker)}`);
    const price = Number(data?.price);
    if (!Number.isFinite(price)) throw new DataSourceError(`no price returned for ${symbol}`);
    return { symbol: `BINANCE:${ticker}`, price };
  }

  /** Current total market cap and BTC dominance, for the CRYPTOCAP watchlist. */
  async getMacroSnapshot() {
    const data = await this.#json(`${COINGECKO}/global`);
    const d = data?.data;
    if (!d) throw new DataSourceError('unexpected /global payload');
    const totalUsd = Number(d.total_market_cap?.usd);
    const btcDominance = Number(d.market_cap_percentage?.btc);
    const ethDominance = Number(d.market_cap_percentage?.eth);
    return {
      'CRYPTOCAP:TOTAL': Number.isFinite(totalUsd) ? totalUsd : null,
      'CRYPTOCAP:TOTAL3': Number.isFinite(totalUsd) && Number.isFinite(btcDominance) && Number.isFinite(ethDominance)
        ? totalUsd * (1 - (btcDominance + ethDominance) / 100)
        : null,
      'CRYPTOCAP:BTC.D': Number.isFinite(btcDominance) ? btcDominance : null,
      note: 'TOTAL3 is derived as TOTAL x (1 - BTC.D - ETH.D); current values only, no history',
      as_of: new Date().toISOString(),
    };
  }

  /** Connectivity probe used by tv_health_check. */
  async ping() {
    const started = Date.now();
    await this.#json(`${BINANCE}/ping`);
    return { reachable: true, latency_ms: Date.now() - started };
  }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return 'data source'; }
}
