// Maps internal scanner pair names to MT5 broker symbols.
// FX pairs drop the slash; indices and crypto get their common CFD ticker.
const OVERRIDES: Record<string, string> = {
  "GER40": "GER40",
  "SPX500": "SPX500",
  "US30": "US30",
  "NAS100": "NAS100",
  "UK100": "UK100",
  "JPN225": "JPN225",
  "BTC/USD": "BTCUSD",
};

/**
 * @param pair    internal pair name, e.g. "EUR/USD" or "GER40"
 * @param suffix  broker-specific suffix, e.g. ".m" or "-ECN" (optional)
 */
export function toMt5Symbol(pair: string, suffix = ""): string {
  const base = OVERRIDES[pair] ?? pair.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return `${base}${suffix}`;
}
