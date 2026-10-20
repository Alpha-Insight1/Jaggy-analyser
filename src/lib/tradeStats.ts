/** Shared paper-trade stats helpers (R multiples from trades table). */

export type TradeRow = {
  pair: string;
  status: "open" | "win" | "loss" | string;
  direction?: string;
  entry?: number | null;
  stop_loss?: number | null;
  initial_stop_loss?: number | null;
  close_price?: number | null;
  risk_reward?: number | null;
  closed_at?: string | null;
  opened_at?: string | null;
  tp1_hit?: boolean | null;
  protection_active?: boolean | null;
  structure?: string | null;
  signal_style?: string | null;
};

export function isCryptoPair(pair: string): boolean {
  const p = pair.toUpperCase();
  return (
    p.includes("BTC") ||
    p.includes("ETH") ||
    p.includes("XRP") ||
    p.includes("SOL") ||
    p.endsWith("USDT") ||
    p.endsWith("USD") && (p.startsWith("BTC") || p.startsWith("ETH"))
  );
}

export function isGoldPair(pair: string): boolean {
  const p = pair.toUpperCase();
  return p.includes("XAU") || p.includes("GOLD");
}

export function isIndexPair(pair: string): boolean {
  const p = pair.toUpperCase();
  return (
    p.includes("US30") ||
    p.includes("NAS") ||
    p.includes("SPX") ||
    p.includes("GER") ||
    p.includes("UK100") ||
    p.includes("JPN") ||
    p.includes("NDX") ||
    p.includes("DJ") ||
    p.includes("DAX")
  );
}

/** Style bucket for performance breakdown */
export type StyleBucket = "Forex" | "Gold" | "Crypto" | "Indices" | "Other";

export function styleOf(pair: string, structure?: string | null): StyleBucket {
  if (isGoldPair(pair)) return "Gold";
  if (isCryptoPair(pair)) return "Crypto";
  if (isIndexPair(pair)) return "Indices";
  // FX pairs look like EUR/USD
  if (/^[A-Z]{3}\/[A-Z]{3}$/i.test(pair) || /^[A-Z]{6}$/i.test(pair.replace("/", ""))) {
    return "Forex";
  }
  if (structure?.toLowerCase().includes("scalp")) return "Gold";
  return "Other";
}

/**
 * Realized R for a closed trade.
 * Prefer close vs initial risk; backend may set close to peak MFE price.
 */
export function realizedR(t: TradeRow): number {
  if (t.status === "open") return 0;
  const risk = Math.abs(Number(t.entry) - Number(t.initial_stop_loss ?? t.stop_loss));
  if (risk > 0 && t.close_price != null && Number.isFinite(Number(t.close_price))) {
    const entry = Number(t.entry);
    const close = Number(t.close_price);
    // Impossible exit (e.g. GER40 exit 83009 vs entry ~25k) → ignore close, use safe fallback
    if (entry > 0 && (close > entry * 2.5 || close < entry * 0.4)) {
      if (t.status === "loss") return -1;
      const planned = Number(t.risk_reward);
      if (Number.isFinite(planned) && planned > 0 && planned <= 8) return planned;
      return 0; // don't poison equity with glitch
    }
    const move =
      t.direction === "SELL" ? entry - close : close - entry;
    const r = move / risk;
    if (r > 8) return 8;
    if (r < -1.5) return -1;
    return r;
  }
  if (t.status === "loss") return -1;
  if (t.status === "win") {
    if (t.tp1_hit && t.protection_active) return 0;
    const planned = Number(t.risk_reward);
    if (Number.isFinite(planned) && planned > 0) return Math.min(planned, 8);
    return 1.5;
  }
  return 0;
}

export function isClosed(t: TradeRow): boolean {
  return t.status === "win" || t.status === "loss";
}

export function withinLastDays(iso: string | null | undefined, days: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= Date.now() - days * 24 * 60 * 60 * 1000;
}

export type Aggregate = {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netR: number;
  avgR: number;
};

export function aggregate(trades: TradeRow[]): Aggregate {
  const closed = trades.filter(isClosed);
  const wins = closed.filter((t) => t.status === "win").length;
  const losses = closed.filter((t) => t.status === "loss").length;
  const netR = closed.reduce((a, t) => a + realizedR(t), 0);
  const n = closed.length;
  return {
    trades: n,
    wins,
    losses,
    winRate: n ? Math.round((wins / n) * 100) : 0,
    netR,
    avgR: n ? netR / n : 0,
  };
}
