// SMC Multi-Timeframe Trading Engine
// Structure: 1D bias + 4H structure (all pairs)
// Entry TF by asset class:
//   Forex  → 15M confirmation (swing)
//   Indices → 5M confirmation (swing)
//   Gold   → 5M confirmation (swing) + separate 1H→5M BOS scalp
// Risk model: ATR(14)-based stop on structure TF, tighter ATR on scalp
// Persists signals in `trades` and resolves them bar-by-bar
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Direct FCM send (no Lovable gateway). Uses Firebase Cloud Messaging legacy
// server key stored as a Supabase Edge Function secret:
//   FIREBASE_SERVER_KEY  (or FCM_SERVER_KEY)
// Get it: Firebase Console → Project settings → Cloud Messaging →
//   Cloud Messaging API (Legacy) → Server key
async function sendTradePush(title: string, body: string, eventId: string): Promise<void> {
  const serverKey =
    Deno.env.get("FIREBASE_SERVER_KEY") ??
    Deno.env.get("FCM_SERVER_KEY") ??
    Deno.env.get("FIREBASE_MESSAGING_API_KEY");

  if (!serverKey) {
    console.warn(
      "Trade push skipped: set FIREBASE_SERVER_KEY secret on the edge function " +
        "(Firebase → Project settings → Cloud Messaging → Server key)",
    );
    return;
  }

  const { data: subscriptions, error } = await db
    .from("push_subscriptions")
    .select("id, token");
  if (error) {
    console.error("Could not load push subscriptions:", error.message);
    return;
  }

  const tokens = (subscriptions ?? []).filter((s) => s.token && String(s.token).length > 20);
  if (!tokens.length) {
    console.warn("Trade push skipped: no device tokens in push_subscriptions");
    return;
  }

  await Promise.all(tokens.map(async (subscription) => {
    try {
      const response = await fetch("https://fcm.googleapis.com/fcm/send", {
        method: "POST",
        headers: {
          Authorization: `key=${serverKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: subscription.token,
          priority: "high",
          notification: {
            title,
            body,
            icon: "/logo.svg",
            click_action: "/",
          },
          data: {
            title,
            body,
            event_id: eventId,
            url: "/",
          },
        }),
      });

      const details = await response.text();
      if (!response.ok) {
        console.error(`Trade push failed [${response.status}]: ${details}`);
        // Invalid / unregistered token → remove so we don't keep failing
        if (
          response.status === 400 ||
          response.status === 404 ||
          details.includes("NotRegistered") ||
          details.includes("InvalidRegistration")
        ) {
          await db.from("push_subscriptions").delete().eq("id", subscription.id);
        }
        return;
      }

      // FCM returns 200 even for some token errors — check body
      try {
        const parsed = JSON.parse(details);
        if (parsed.failure >= 1 || parsed.results?.[0]?.error) {
          const err = parsed.results?.[0]?.error ?? "unknown";
          console.error(`Trade push token error: ${err}`);
          if (err === "NotRegistered" || err === "InvalidRegistration") {
            await db.from("push_subscriptions").delete().eq("id", subscription.id);
          }
        }
      } catch {
        // non-JSON body — ignore
      }
    } catch (e) {
      console.error("Trade push network error:", e instanceof Error ? e.message : e);
    }
  }));
}

interface Candle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

interface Swing {
  index: number;
  price: number;
  type: "high" | "low";
}

interface OrderBlock {
  index: number;
  top: number;
  bottom: number;
  type: "bullish" | "bearish";
}

interface FVG {
  index: number;
  top: number;
  bottom: number;
  type: "bullish" | "bearish";
}

interface ConfidenceFactor {
  label: string;
  points: number;
  hit: boolean;
}

interface Signal {
  pair: string;
  direction: "BUY" | "SELL";
  entry: number;
  stopLoss: number;
  takeProfit: number;        // TP1 — partial close (5R)
  takeProfit2: number;       // TP2 — runner (15R)
  riskReward: number;        // Reported RR = TP1 (primary target); TP2 is runner only
  confidence: number;
  structure: "BOS" | "CHoCH";
  confluences: string[];
  // Per-factor breakdown showing exactly how the confidence score was assembled.
  // The UI renders this so traders can see *why* a setup scored 87% vs 80%.
  confidenceBreakdown: ConfidenceFactor[];
  currentPrice: number;
  timestamp: string;
  htf_bias: "Bullish" | "Bearish" | "Neutral";
  // Optional deeper SWING entry tier — fills at the daily HTF S/R level for a
  // higher-conviction discount/premium entry vs the LTF (proximal-OB) entry.
  swingEntry?: number;
  swingStopLoss?: number;
  swingRiskPips?: number;
  // Split-entry smoothing: when both LTF and swing tiers exist, scale in 50/50
  // across the two limits. UI shows the blended fill + blended risk so the
  // trader knows the effective entry if both fill.
  splitEntry?: {
    tier1: number;       // LTF proximal entry (50% allocation)
    tier2: number;       // Deeper swing entry (50% allocation)
    allocation: number;  // 0.5 = even split
    blendedEntry: number;
    blendedRiskPips: number;
  };
  // LTF (1h) confirmation gate: did the lower timeframe print a structure
  // shift (BOS/CHoCH) in the trade direction? When false, the signal is
  // valid on HTF but should wait for LTF confirmation before firing limits.
  ltfConfirmed?: boolean;
  awaitingLtfConfirmation?: boolean;
  // Auto-trigger override: when confidence ≥ 95%, fire the trade immediately
  // regardless of LTF confirmation — the HTF conviction is high enough to skip
  // the wait gate. UI shows a "AUTO-FIRE" pill so the trader knows to execute now.
  autoTrigger?: boolean;
  // Professional entry model that produced this entry price + how the trade
  // should be triggered on the platform. Market-on-confirmation means the
  // trader fires at market once the 1H confirmation candle has closed inside
  // the zone — no set-and-forget limit.
  entryModel?: "OTE" | "FVG" | "Breaker" | "Judas" | "OB";
  entryTrigger?: "MARKET_ON_CONFIRMATION" | "LIMIT";
  entryZone?: { top: number; bottom: number };
  // Multi-TF labels
  signalStyle?: "swing" | "scalp";
  structureTimeframe?: string;  // e.g. "4H" or "1H"
  entryTimeframe?: string;      // e.g. "15M" | "5M"

}

// A "developing" setup is forming but hasn't passed all gates yet —
// these are the pairs to actively watch (news-driven moves, near-trigger zones, etc).
interface DevelopingSetup {
  pair: string;
  direction: "BUY" | "SELL";
  htf_bias: "Bullish" | "Bearish";
  reason: string;
  proximity: number;
  currentPrice: number;
  newsMomentum: boolean;
  triggers: string[];
  // Proposed trade plan (computed even if signal not yet firing) — null when no
  // anchor (OB or sweep) is available to compute meaningful levels.
  plan: {
    entry: number;
    stopLoss: number;
    takeProfit: number;   // TP1 (2R)
    takeProfit2: number;  // TP2 (8R)
    riskPips: number;
    // Deeper swing entry (daily HTF zone) — optional. When present, this is
    // the higher-conviction fill at a discount/premium level vs the LTF entry.
    swingEntry?: number;
    swingStopLoss?: number;
    swingRiskPips?: number;
  } | null;
}

// 28 FX pairs + major indices + BTC. Free Yahoo Finance symbols.
const PAIRS: { pair: string; yfSymbol: string }[] = [
  // Indices & Crypto (institutional flow proxies)
  { pair: "GER40",   yfSymbol: "^GDAXI" },
  { pair: "SPX500",  yfSymbol: "^GSPC" },
  { pair: "US30",    yfSymbol: "^DJI" },
  { pair: "NAS100",  yfSymbol: "^NDX" },
  { pair: "UK100",   yfSymbol: "^FTSE" },
  { pair: "JPN225",  yfSymbol: "^N225" },
  { pair: "XAU/USD", yfSymbol: "GC=F" },  // Gold (futures for reliable LTF data)
  { pair: "BTC/USD", yfSymbol: "BTC-USD" },
  // Majors
  { pair: "EUR/USD", yfSymbol: "EURUSD=X" },
  { pair: "GBP/USD", yfSymbol: "GBPUSD=X" },
  { pair: "USD/JPY", yfSymbol: "JPY=X" },
  { pair: "USD/CHF", yfSymbol: "CHF=X" },
  { pair: "AUD/USD", yfSymbol: "AUDUSD=X" },
  { pair: "USD/CAD", yfSymbol: "CAD=X" },
  { pair: "NZD/USD", yfSymbol: "NZDUSD=X" },
  // EUR crosses
  { pair: "EUR/GBP", yfSymbol: "EURGBP=X" },
  { pair: "EUR/JPY", yfSymbol: "EURJPY=X" },
  { pair: "EUR/CHF", yfSymbol: "EURCHF=X" },
  { pair: "EUR/AUD", yfSymbol: "EURAUD=X" },
  { pair: "EUR/CAD", yfSymbol: "EURCAD=X" },
  { pair: "EUR/NZD", yfSymbol: "EURNZD=X" },
  // GBP crosses
  { pair: "GBP/JPY", yfSymbol: "GBPJPY=X" },
  { pair: "GBP/CHF", yfSymbol: "GBPCHF=X" },
  { pair: "GBP/AUD", yfSymbol: "GBPAUD=X" },
  { pair: "GBP/CAD", yfSymbol: "GBPCAD=X" },
  { pair: "GBP/NZD", yfSymbol: "GBPNZD=X" },
  // JPY crosses
  { pair: "AUD/JPY", yfSymbol: "AUDJPY=X" },
  { pair: "CAD/JPY", yfSymbol: "CADJPY=X" },
  { pair: "CHF/JPY", yfSymbol: "CHFJPY=X" },
  { pair: "NZD/JPY", yfSymbol: "NZDJPY=X" },
  // Other crosses
  { pair: "AUD/CAD", yfSymbol: "AUDCAD=X" },
  { pair: "AUD/CHF", yfSymbol: "AUDCHF=X" },
  { pair: "AUD/NZD", yfSymbol: "AUDNZD=X" },
  { pair: "CAD/CHF", yfSymbol: "CADCHF=X" },
  { pair: "NZD/CAD", yfSymbol: "NZDCAD=X" },
  { pair: "NZD/CHF", yfSymbol: "NZDCHF=X" },
];

// Asset-class helpers: FX uses pips; indices/crypto use points/dollars.
function isIndex(pair: string): boolean {
  return pair === "GER40" || pair === "US30" || pair === "NAS100" || pair === "SPX500"
      || pair === "UK100" || pair === "JPN225";
}
function isGold(pair: string): boolean {
  return pair === "XAU/USD" || pair.startsWith("XAU");
}
function isCrypto(pair: string): boolean {
  return pair.startsWith("BTC") || pair.startsWith("ETH");
}
/** Entry timeframe used for LTF confirmation by asset class. */
function entryTimeframeFor(pair: string): "5m" | "15m" {
  if (isIndex(pair) || isGold(pair)) return "5m";
  return "15m"; // Forex
}
function entryTfLabel(pair: string): string {
  return entryTimeframeFor(pair) === "5m" ? "5M" : "15M";
}
function pip(pair: string): number {
  if (isIndex(pair)) return 1;          // 1 point = 1 pip
  if (isGold(pair)) return 0.1;         // gold typically $0.10 tick / pip display
  if (isCrypto(pair)) return 1;         // 1 USD = 1 pip
  return pair.includes("JPY") ? 0.01 : 0.0001;
}
function priceDecimals(pair: string): number {
  if (isIndex(pair)) return 2;
  if (isGold(pair)) return 2;
  if (isCrypto(pair)) return 2;
  return pair.includes("JPY") ? 3 : 5;
}
// Minimum risk distance — relative to ATR so it works on FX, indices, and BTC.
// Rejects setups where stop is so tight any noise will hit it.
function minRiskFor(pair: string, atrVal: number): number {
  return atrVal * 0.5;
}
// Pip distance for reporting — abstract away FX vs index vs crypto unit math.
function toPips(pair: string, distance: number): number {
  const p = pip(pair);
  if (isIndex(pair) || isCrypto(pair) || isGold(pair)) return distance / p;
  return pair.includes("JPY") ? distance / (p * 10) : distance / p;
}

// Detect swing highs/lows using a 2-bar lookback fractal
function findSwings(candles: Candle[], lookback = 2): Swing[] {
  const swings: Swing[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isHigh = false;
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) isLow = false;
    }
    if (isHigh) swings.push({ index: i, price: candles[i].high, type: "high" });
    if (isLow) swings.push({ index: i, price: candles[i].low, type: "low" });
  }
  return swings;
}

// Determine market structure: BOS (continuation) or CHoCH (reversal)
function analyzeStructure(candles: Candle[], swings: Swing[]): {
  structure: "BOS" | "CHoCH" | null;
  trend: "Bullish" | "Bearish" | "Neutral";
  brokenLevel: number | null;
  brokenAtIndex: number | null;
} {
  if (swings.length < 4) return { structure: null, trend: "Neutral", brokenLevel: null, brokenAtIndex: null };

  const highs = swings.filter((s) => s.type === "high").slice(-3);
  const lows = swings.filter((s) => s.type === "low").slice(-3);

  // Determine prior trend from last 2 highs and lows
  let priorTrend: "Bullish" | "Bearish" | "Neutral" = "Neutral";
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs[highs.length - 1].price > highs[highs.length - 2].price;
    const hl = lows[lows.length - 1].price > lows[lows.length - 2].price;
    const lh = highs[highs.length - 1].price < highs[highs.length - 2].price;
    const ll = lows[lows.length - 1].price < lows[lows.length - 2].price;
    if (hh && hl) priorTrend = "Bullish";
    else if (lh && ll) priorTrend = "Bearish";
  }

  // Look for a broken swing across the recent window (~20 bars on the 4H,
  // roughly 3 days). We test the last few swing highs/lows, not only the very
  // latest one — after a BOS the newest swing is often the break itself, so
  // checking only that level would hide a perfectly valid, fresh structure
  // break that price is now pulling back into.
  const recent = candles.slice(-20);
  const startIdx = candles.length - recent.length;
  const candHighs = highs.slice(-3);
  const candLows = lows.slice(-3);

  let brokenUp = false;
  let brokenDown = false;
  let brokenLevel: number | null = null;
  let brokenAtIndex: number | null = null;
  let upAt = -1;
  let downAt = -1;
  let upLevel: number | null = null;
  let downLevel: number | null = null;

  for (let i = Math.max(0, startIdx); i < candles.length; i++) {
    for (const h of candHighs) {
      if (candles[i].close > h.price && i > h.index && i > upAt) {
        brokenUp = true;
        upAt = i;
        upLevel = h.price;
      }
    }
    for (const l of candLows) {
      if (candles[i].close < l.price && i > l.index && i > downAt) {
        brokenDown = true;
        downAt = i;
        downLevel = l.price;
      }
    }
  }

  // If both sides broke inside the window, the most recent break wins.
  if (brokenUp && brokenDown) {
    if (upAt >= downAt) brokenDown = false;
    else brokenUp = false;
  }
  if (brokenUp) {
    brokenLevel = upLevel;
    brokenAtIndex = upAt;
  } else if (brokenDown) {
    brokenLevel = downLevel;
    brokenAtIndex = downAt;
  }


  if (brokenUp) {
    return {
      structure: priorTrend === "Bearish" ? "CHoCH" : "BOS",
      trend: "Bullish",
      brokenLevel,
      brokenAtIndex,
    };
  }
  if (brokenDown) {
    return {
      structure: priorTrend === "Bullish" ? "CHoCH" : "BOS",
      trend: "Bearish",
      brokenLevel,
      brokenAtIndex,
    };
  }

  return { structure: null, trend: priorTrend, brokenLevel: null, brokenAtIndex: null };
}

// Find the last opposite-color candle before an impulsive move = order block
function findOrderBlock(
  candles: Candle[],
  brokenAtIndex: number | null,
  direction: "Bullish" | "Bearish"
): OrderBlock | null {
  if (brokenAtIndex === null) return null;
  const lookback = Math.min(15, brokenAtIndex);
  for (let i = brokenAtIndex - 1; i >= brokenAtIndex - lookback && i >= 0; i--) {
    const c = candles[i];
    const bullishCandle = c.close > c.open;
    if (direction === "Bullish" && !bullishCandle) {
      return { index: i, top: c.high, bottom: c.low, type: "bullish" };
    }
    if (direction === "Bearish" && bullishCandle) {
      return { index: i, top: c.high, bottom: c.low, type: "bearish" };
    }
  }
  return null;
}

// Find ALL order blocks across the recent window in the given direction.
// This is what enables "stacked OB" detection — the high-probability pattern
// where price retraces into multiple aligned demand/supply zones (your screenshot).
function findAllOrderBlocks(
  candles: Candle[],
  direction: "Bullish" | "Bearish",
  lookback = 60,
): OrderBlock[] {
  const obs: OrderBlock[] = [];
  const start = Math.max(2, candles.length - lookback);
  for (let i = start; i < candles.length - 1; i++) {
    const c = candles[i];
    const next = candles[i + 1];
    const bullishCandle = c.close > c.open;
    // Bullish OB = down-close candle followed by an up-impulse that takes out its high
    if (direction === "Bullish" && !bullishCandle && next.close > c.high) {
      obs.push({ index: i, top: c.high, bottom: c.low, type: "bullish" });
    }
    // Bearish OB = up-close candle followed by a down-impulse that takes out its low
    if (direction === "Bearish" && bullishCandle && next.close < c.low) {
      obs.push({ index: i, top: c.high, bottom: c.low, type: "bearish" });
    }
  }
  return obs;
}

// An OB is "fresh" (untested) if no candle since its formation has wicked into it.
// Fresh OBs are the highest-probability — once tagged, they lose ~half their edge.
function isFreshOB(candles: Candle[], ob: OrderBlock): boolean {
  for (let i = ob.index + 2; i < candles.length - 1; i++) {
    // wick into the zone
    const c = candles[i];
    if (c.low <= ob.top && c.high >= ob.bottom) return false;
  }
  return true;
}

// Find STACKED order blocks: 2+ fresh OBs in trend direction, separated by ≤2.5×ATR.
// This is the exact pattern in your screenshot (Bu-OB at 1.205 + Bu-OB at 1.195).
// Stacked OBs = layered demand/supply, dramatically higher reversal probability.
function findStackedOBs(
  candles: Candle[],
  direction: "Bullish" | "Bearish",
  atrVal: number,
): OrderBlock[] {
  const all = findAllOrderBlocks(candles, direction, 80);
  const fresh = all.filter((ob) => isFreshOB(candles, ob));
  if (fresh.length < 2) return [];

  // Sort by price (low→high for bullish, high→low for bearish)
  const sorted = [...fresh].sort((a, b) =>
    direction === "Bullish" ? a.bottom - b.bottom : b.top - a.top,
  );

  // Find the closest pair within 2.5×ATR — that's a real "stack"
  const maxGap = atrVal * 2.5;
  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = direction === "Bullish"
      ? sorted[i + 1].bottom - sorted[i].top
      : sorted[i].bottom - sorted[i + 1].top;
    if (gap >= 0 && gap <= maxGap) {
      return [sorted[i], sorted[i + 1]];
    }
  }
  return [];
}

// Count same-direction Market Structure Breaks (MSBs) in the recent window.
// Multiple MSBs in one direction = sustained trend (the "MSB MSB MSB" stacking
// visible across Feb→Apr in your screenshot). 3+ = institutional trend.
function countRecentMSBs(
  candles: Candle[],
  swings: Swing[],
  direction: "Bullish" | "Bearish",
  lookback = 50,
): number {
  if (swings.length < 4) return 0;
  const startIdx = Math.max(0, candles.length - lookback);
  let count = 0;

  if (direction === "Bullish") {
    const highs = swings.filter((s) => s.type === "high" && s.index >= startIdx);
    for (let i = 1; i < highs.length; i++) {
      // BOS up = candle close above prior swing high
      const priorHigh = highs[i - 1].price;
      for (let j = highs[i - 1].index + 1; j <= highs[i].index && j < candles.length; j++) {
        if (candles[j].close > priorHigh) { count++; break; }
      }
    }
  } else {
    const lows = swings.filter((s) => s.type === "low" && s.index >= startIdx);
    for (let i = 1; i < lows.length; i++) {
      const priorLow = lows[i - 1].price;
      for (let j = lows[i - 1].index + 1; j <= lows[i].index && j < candles.length; j++) {
        if (candles[j].close < priorLow) { count++; break; }
      }
    }
  }
  return count;
}

// Fair Value Gap: 3-candle imbalance
function findRecentFVG(candles: Candle[], direction: "Bullish" | "Bearish"): FVG | null {
  for (let i = candles.length - 1; i >= Math.max(2, candles.length - 20); i--) {
    const c1 = candles[i - 2];
    const c3 = candles[i];
    if (direction === "Bullish" && c3.low > c1.high) {
      return { index: i - 1, top: c3.low, bottom: c1.high, type: "bullish" };
    }
    if (direction === "Bearish" && c3.high < c1.low) {
      return { index: i - 1, top: c1.low, bottom: c3.high, type: "bearish" };
    }
  }
  return null;
}

// Simple EMA for higher timeframe bias
function ema(values: number[], period: number): number {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

// ATR(14) — average true range for volatility-adjusted swing stops
function atr(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close),
    );
    trs.push(tr);
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// RSI(14) — momentum filter. >50 = bullish strength, <50 = bearish strength.
// Used to confirm direction at the OB tap (avoid catching falling knives).
function rsi(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgG = gains / period;
  const avgL = losses / period;
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

// Engulfing pattern on the most recent closed 4H candle — confirms reversal at OB.
function isEngulfing(candles: Candle[], direction: "Bullish" | "Bearish"): boolean {
  if (candles.length < 2) return false;
  const prev = candles[candles.length - 2];
  const last = candles[candles.length - 1];
  if (direction === "Bullish") {
    return (
      prev.close < prev.open && // prev bearish
      last.close > last.open && // last bullish
      last.close >= prev.open &&
      last.open <= prev.close
    );
  }
  return (
    prev.close > prev.open && // prev bullish
    last.close < last.open && // last bearish
    last.close <= prev.open &&
    last.open >= prev.close
  );
}

// ---- Structure-anchored SL ----
// Place stop just beyond the most recent protective swing (low for BUY,
// high for SELL) found at or beyond the order-block edge. Adds a small
// ATR buffer for wick noise. Falls back to OB ± buffer if no swing found.
function structuralStop(
  candles: Candle[],
  swings: Swing[],
  direction: "BUY" | "SELL",
  obEdge: number,        // OB.bottom for BUY, OB.top for SELL
  atrVal: number,
  lookback = 30,
): number {
  const buffer = atrVal * 0.75;
  const startIdx = Math.max(0, candles.length - lookback);
  const recent = swings.filter((s) => s.index >= startIdx);
  if (direction === "BUY") {
    const lows = recent.filter((s) => s.type === "low" && s.price <= obEdge);
    if (lows.length > 0) {
      const deepest = Math.min(...lows.map((s) => s.price));
      return deepest - buffer;
    }
    return obEdge - buffer;
  }
  const highs = recent.filter((s) => s.type === "high" && s.price >= obEdge);
  if (highs.length > 0) {
    const tallest = Math.max(...highs.map((s) => s.price));
    return tallest + buffer;
  }
  return obEdge + buffer;
}

// ---- Realistic TP1: nearest opposing LTF swing in trade direction ----
function nearestOpposingSwing(
  swings: Swing[],
  direction: "BUY" | "SELL",
  entry: number,
  minDistance: number,   // must be at least this far away (e.g. 1×R)
): number | null {
  const cand = swings.filter((s) =>
    direction === "BUY"
      ? s.type === "high" && s.price > entry + minDistance
      : s.type === "low" && s.price < entry - minDistance,
  );
  if (cand.length === 0) return null;
  return direction === "BUY"
    ? Math.min(...cand.map((s) => s.price))
    : Math.max(...cand.map((s) => s.price));
}

// ---- Realistic TP2: next HTF (daily) zone in trade direction ----
function nextHTFZone(
  zones: SRZone[],
  direction: "BUY" | "SELL",
  entry: number,
  minDistance: number,
): number | null {
  const opposing: SRZone["type"] = direction === "BUY" ? "resistance" : "support";
  const cand = zones.filter((z) =>
    z.type === opposing &&
    (direction === "BUY" ? z.price > entry + minDistance : z.price < entry - minDistance),
  );
  if (cand.length === 0) return null;
  return direction === "BUY"
    ? Math.min(...cand.map((z) => z.price))
    : Math.max(...cand.map((z) => z.price));
}

// Strong HTF support/resistance zones from DAILY swings.
// "Strong" = a level tested ≥2 times within ATR-tolerance. This is the
// "support" you ride from in the GBPCAD example.
interface SRZone {
  price: number;
  type: "support" | "resistance";
  touches: number;
}
function findHTFZones(daily: Candle[]): SRZone[] {
  if (daily.length < 30) return [];
  const swings = findSwings(daily, 3);
  const dAtr = atr(daily, 14);
  const tol = dAtr * 0.5; // levels within 0.5×ATR are "the same zone"
  const zones: SRZone[] = [];

  const cluster = (sw: Swing[], type: "support" | "resistance") => {
    const sorted = [...sw].sort((a, b) => a.price - b.price);
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      let sum = 0;
      let count = 0;
      while (j < sorted.length && sorted[j].price - sorted[i].price <= tol) {
        sum += sorted[j].price;
        count++;
        j++;
      }
      zones.push({ price: sum / count, type, touches: count });
      i = j;
    }
  };
  cluster(swings.filter((s) => s.type === "low"), "support");
  cluster(swings.filter((s) => s.type === "high"), "resistance");
  // Strong = ≥2 touches
  return zones.filter((z) => z.touches >= 2);
}

// Is current price reacting from a strong HTF zone? (within 1.5×4H-ATR)
function nearStrongZone(
  price: number,
  zones: SRZone[],
  type: "support" | "resistance",
  tolerance: number,
): SRZone | null {
  let best: SRZone | null = null;
  for (const z of zones) {
    if (z.type !== type) continue;
    if (Math.abs(price - z.price) <= tolerance) {
      if (!best || z.touches > best.touches) best = z;
    }
  }
  return best;
}

// Did price RETEST the broken structure level? (break-and-retest = high prob)
// Returns true if, after the BOS, price came back within retestTol of the broken level.
function hasRetested(
  candles: Candle[],
  brokenLevel: number,
  brokenAtIndex: number,
  tolerance: number,
): boolean {
  for (let i = brokenAtIndex + 1; i < candles.length; i++) {
    const c = candles[i];
    if (Math.abs(c.low - brokenLevel) <= tolerance) return true;
    if (Math.abs(c.high - brokenLevel) <= tolerance) return true;
  }
  return false;
}

function mergeCandles(group: Candle[]): Candle {
  return {
    time: group[0].time,
    open: group[0].open,
    high: Math.max(...group.map((c) => c.high)),
    low: Math.min(...group.map((c) => c.low)),
    close: group[group.length - 1].close,
  };
}

// Resample 1h -> 4h aligned to UTC 4-hour boundaries
function resampleTo4H(hourly: Candle[]): Candle[] {
  const out: Candle[] = [];
  let bucket: Candle[] = [];
  let bucketKey = -1;
  for (const c of hourly) {
    const d = new Date(c.time * 1000);
    const slot = Math.floor(d.getUTCHours() / 4);
    const day = Math.floor(c.time / 86400);
    const key = day * 10 + slot;
    if (bucket.length === 0 || key === bucketKey) {
      bucket.push(c);
      bucketKey = key;
    } else {
      out.push(mergeCandles(bucket));
      bucket = [c];
      bucketKey = key;
    }
  }
  if (bucket.length) out.push(mergeCandles(bucket));
  return out;
}

// ---------- DAX-STYLE INTRADAY FILTERS ----------
// These mirror the Frankfurt/London open playbook on the German DAX index:
// 1) Asian range = liquidity pool. Wait for a sweep of the Asian high/low
//    during the London or NY kill-zone, then enter on the reversal.
// 2) Displacement candle = strong, decisive move (>=1.2x ATR body) that
//    confirms smart-money has stepped in (not slow drift).
// 3) Kill-zones = the only times institutional volume is reliably present.

// London kill-zone: 07:00–10:00 UTC. NY kill-zone: 12:00–15:00 UTC.
// Outside these windows, smart-money setups usually fail or chop.
function inKillZone(time: number): { active: boolean; session: "London" | "NewYork" | null } {
  const h = new Date(time * 1000).getUTCHours();
  if (h >= 7 && h < 10) return { active: true, session: "London" };
  if (h >= 12 && h < 15) return { active: true, session: "NewYork" };
  return { active: false, session: null };
}

// ---- Per-instrument trading session windows (UTC) ----
// Liquidity is instrument-specific: trading an index outside its cash session
// or FX outside London/NY is where most low-quality fills come from.
function sessionWindow(pair: string): { start: number; end: number; label: string } | null {
  if (isCrypto(pair)) return null; // 24/7
  if (isGold(pair)) return { start: 1, end: 22, label: "Gold London–NY" }; // nearly 24h weekdays
  if (isIndex(pair)) {
    if (pair === "JPN225") return { start: 0, end: 6, label: "Tokyo cash" };
    if (pair === "GER40" || pair === "UK100") return { start: 7, end: 15.5, label: "Europe cash" };
    return { start: 13.5, end: 20, label: "US cash" }; // SPX500 / US30 / NAS100
  }
  return { start: 7, end: 16, label: "London–NY overlap window" }; // FX
}

function inTradingSession(pair: string, d: Date): { ok: boolean; label: string } {
  const w = sessionWindow(pair);
  if (!w) return { ok: true, label: "24/7" };
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  return { ok: h >= w.start && h < w.end, label: w.label };
}

// ---- High-impact news blackout (UTC) ----
// No calendar feed is wired in, so we blackout the recurring release windows
// that produce the worst slippage: US data 12:30, US mid-session 14:00 (ISM/
// confidence) and the FOMC statement 18:00 (Wednesdays). ±35 min buffer.
function inNewsBlackout(pair: string, d: Date): { blocked: boolean; label: string } {
  if (isCrypto(pair)) return { blocked: false, label: "" };
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return { blocked: false, label: "" };
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  const near = (target: number) => Math.abs(mins - target) <= 35;
  if (near(12 * 60 + 30)) return { blocked: true, label: "US 12:30 UTC data release" };
  if (near(14 * 60)) return { blocked: true, label: "US 14:00 UTC data release" };
  if (dow === 3 && near(18 * 60)) return { blocked: true, label: "FOMC 18:00 UTC" };
  return { blocked: false, label: "" };
}


// Asian session range (00:00–06:00 UTC) on the most recent trading day.
// This is the liquidity pool DAX traders hunt at the London open.
function asianRange(hourly: Candle[]): { high: number; low: number } | null {
  if (!hourly.length) return null;
  // Find the most recent Asian session window in the data
  for (let dayBack = 0; dayBack < 5; dayBack++) {
    const now = hourly[hourly.length - 1].time;
    const dayStart = Math.floor(now / 86400) * 86400 - dayBack * 86400;
    const sessionStart = dayStart;
    const sessionEnd = dayStart + 6 * 3600;
    const session = hourly.filter((c) => c.time >= sessionStart && c.time < sessionEnd);
    if (session.length >= 3) {
      return {
        high: Math.max(...session.map((c) => c.high)),
        low: Math.min(...session.map((c) => c.low)),
      };
    }
  }
  return null;
}

// Did price sweep the Asian range (wick beyond, close back inside)
// in the last `lookback` candles, and is the close in `direction`?
function asianSweep(
  hourly: Candle[],
  range: { high: number; low: number },
  direction: "Bullish" | "Bearish",
  lookback = 8,
): { swept: number; sweptAt: number } | null {
  const start = Math.max(0, hourly.length - lookback);
  for (let i = start; i < hourly.length; i++) {
    const c = hourly[i];
    if (direction === "Bullish") {
      // Bullish setup: sweep the LOW (sellers trapped), close back above
      if (c.low < range.low && c.close > range.low) {
        return { swept: range.low, sweptAt: i };
      }
    } else {
      // Bearish setup: sweep the HIGH (buyers trapped), close back below
      if (c.high > range.high && c.close < range.high) {
        return { swept: range.high, sweptAt: i };
      }
    }
  }
  return null;
}

// Displacement: a single candle with body >= 1.2x ATR moving in `direction`.
// This is the "smart money has fired" signature DAX traders wait for.
function hasDisplacement(
  candles: Candle[],
  direction: "Bullish" | "Bearish",
  atrVal: number,
  lookback = 5,
): boolean {
  if (atrVal <= 0) return false;
  const start = Math.max(0, candles.length - lookback);
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const body = Math.abs(c.close - c.open);
    if (body < atrVal * 1.2) continue;
    if (direction === "Bullish" && c.close > c.open) return true;
    if (direction === "Bearish" && c.close < c.open) return true;
  }
  return false;
}

// Liquidity Sweep (a.k.a. stop hunt): price wicks BEYOND a recent swing high/low,
// then closes back inside. This traps breakout traders and signals smart-money entry.
// Returns the swept level + direction implication, or null if no recent sweep.
function findLiquiditySweep(
  candles: Candle[],
  swings: Swing[],
  direction: "Bullish" | "Bearish",
): { level: number; sweptAt: number } | null {
  // Look at the last 5 candles for a sweep
  const recent = candles.slice(-5);
  const startIdx = candles.length - recent.length;

  if (direction === "Bullish") {
    // Bullish setup needs a sweep of recent LOWS (sellers trapped)
    const lows = swings.filter((s) => s.type === "low" && s.index < startIdx).slice(-3);
    if (!lows.length) return null;
    for (let i = 0; i < recent.length; i++) {
      const c = recent[i];
      for (const lw of lows) {
        if (c.low < lw.price && c.close > lw.price) {
          return { level: lw.price, sweptAt: startIdx + i };
        }
      }
    }
  } else {
    // Bearish setup needs a sweep of recent HIGHS (buyers trapped)
    const highs = swings.filter((s) => s.type === "high" && s.index < startIdx).slice(-3);
    if (!highs.length) return null;
    for (let i = 0; i < recent.length; i++) {
      const c = recent[i];
      for (const hi of highs) {
        if (c.high > hi.price && c.close < hi.price) {
          return { level: hi.price, sweptAt: startIdx + i };
        }
      }
    }
  }
  return null;
}


// SWING TRADING: 4H structure (resampled from 1h) + Daily HTF bias

function pairToYahoo(pair: string): string {
  return PAIRS.find((p) => p.pair === pair)?.yfSymbol ?? pair.replace("/", "") + "=X";
}

async function fetchYahooCandles(
  pair: string,
  interval: "4h" | "1h" | "1d" | "5m" | "15m" | "30m",
  range: "5d" | "7d" | "1mo" | "3mo" | "6mo" | "1y" | "2y",
): Promise<Candle[]> {
  const sym = pairToYahoo(pair);
  // Yahoo doesn't expose native 4h FX — fetch 1h and resample
  const fetchInterval = interval === "4h" ? "1h" : interval;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    sym,
  )}?interval=${fetchInterval}&range=${range}`;

  // Yahoo Finance occasionally returns 5xx under load — retry once with backoff,
  // and fall back to query2 host on persistent failure.
  const fetchWithRetry = async (u: string): Promise<Response> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(u, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "application/json",
        },
      });
      if (res.ok) return res;
      if (res.status < 500) return res; // 4xx — don't retry
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    // Final fallback to query2 host
    return fetch(u.replace("query1.finance", "query2.finance"), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json",
      },
    });
  };

  const r = await fetchWithRetry(url);
  if (!r.ok) throw new Error(`Yahoo HTTP ${r.status} for ${pair}`);
  const j = await r.json();
  const result = j?.chart?.result?.[0];
  if (!result || j?.chart?.error) {
    throw new Error(`Yahoo error for ${pair}: ${j?.chart?.error?.description ?? "no data"}`);
  }
  const ts: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0];
  if (!ts.length || !q) throw new Error(`Yahoo returned empty data for ${pair}`);

  const raw: Candle[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    if (o == null || h == null || l == null || c == null) continue;
    raw.push({ time: ts[i], open: o, high: h, low: l, close: c });
  }
  return interval === "4h" ? resampleTo4H(raw) : raw;
  }


// ============================================================================
// PROFESSIONAL ENTRY MODELS (ICT / SMC playbook)
// ----------------------------------------------------------------------------
// We stop firing on the raw OB proximal edge and instead pick the best of four
// pro-trader entry models — whichever gives the tightest, highest-probability
// fill within the current pullback:
//   1. OTE          — 61.8–79% fib retrace of the impulse leg (sweet spot 70.5%)
//   2. FVG fill     — mitigation of the fair-value-gap midpoint
//   3. Breaker      — retest of a failed OB that flipped role after a sweep
//   4. Judas sweep  — stop-hunt of session high/low then 1H CHoCH; enter on
//                     retest of the CHoCH origin candle
//
// Every entry then requires a 1H CONFIRMATION CANDLE close inside the zone in
// trade direction (rejection body). Trade fires at MARKET on that close — no
// blind limits sitting in the zone.
// ============================================================================

interface EntryZone { top: number; bottom: number; }
interface ProEntry {
  price: number;
  zone: EntryZone;
  model: "OTE" | "FVG" | "Breaker" | "Judas";
  stopAnchor: number; // structural invalidation for this specific model
}

// OTE = Optimal Trade Entry (61.8–79% fib retrace of the impulse leg).
// For a BUY: impulse = swing low → most recent swing high before the pullback.
// Sweet-spot entry = 70.5%.
function computeOTE(
  candles: Candle[],
  swings: Swing[],
  direction: "BUY" | "SELL",
  lookback = 40,
): ProEntry | null {
  const startIdx = Math.max(0, candles.length - lookback);
  const recent = swings.filter((s) => s.index >= startIdx);
  if (recent.length < 2) return null;
  if (direction === "BUY") {
    const highs = recent.filter((s) => s.type === "high");
    const lows = recent.filter((s) => s.type === "low");
    if (!highs.length || !lows.length) return null;
    const legHigh = highs.reduce((a, b) => (a.price > b.price ? a : b));
    const priorLows = lows.filter((s) => s.index < legHigh.index);
    if (!priorLows.length) return null;
    const legLow = priorLows.reduce((a, b) => (a.price < b.price ? a : b));
    const range = legHigh.price - legLow.price;
    if (range <= 0) return null;
    const top = legHigh.price - range * 0.618;
    const bottom = legHigh.price - range * 0.79;
    const price = legHigh.price - range * 0.705; // sweet spot
    return { price, zone: { top, bottom }, model: "OTE", stopAnchor: legLow.price };
  }
  const highs = recent.filter((s) => s.type === "high");
  const lows = recent.filter((s) => s.type === "low");
  if (!highs.length || !lows.length) return null;
  const legLow = lows.reduce((a, b) => (a.price < b.price ? a : b));
  const priorHighs = highs.filter((s) => s.index < legLow.index);
  if (!priorHighs.length) return null;
  const legHigh = priorHighs.reduce((a, b) => (a.price > b.price ? a : b));
  const range = legHigh.price - legLow.price;
  if (range <= 0) return null;
  const bottom = legLow.price + range * 0.618;
  const top = legLow.price + range * 0.79;
  const price = legLow.price + range * 0.705;
  return { price, zone: { bottom, top }, model: "OTE", stopAnchor: legHigh.price };
}

// FVG fill entry — mitigate the imbalance midpoint.
function fvgEntry(fvg: FVG | null, direction: "BUY" | "SELL", swings: Swing[]): ProEntry | null {
  if (!fvg) return null;
  const mid = (fvg.top + fvg.bottom) / 2;
  // Stop just beyond the FVG's origin side (protective swing)
  const stopAnchor = direction === "BUY" ? fvg.bottom : fvg.top;
  return {
    price: mid,
    zone: { top: fvg.top, bottom: fvg.bottom },
    model: "FVG",
    stopAnchor,
  };
}

// Breaker block — a failed OB that flipped role after a liquidity sweep.
// BUY: find a recent BEARISH OB (rejection zone) that got broken to the upside;
// it now acts as demand (breaker). Enter on retest of its top edge.
function findBreaker(
  candles: Candle[],
  direction: "BUY" | "SELL",
  lookback = 60,
): ProEntry | null {
  const start = Math.max(0, candles.length - lookback);
  // Scan for opposite-color candles that got broken through by a strong close
  for (let i = candles.length - 4; i >= start + 2; i--) {
    const c = candles[i];
    const isDownCandle = c.close < c.open;
    const isUpCandle = c.close > c.open;
    if (direction === "BUY" && isDownCandle) {
      // Was it broken to the upside within the next `lookback` bars?
      for (let j = i + 1; j < candles.length; j++) {
        if (candles[j].close > c.high) {
          // Confirmed breaker: bearish candle now flipped to demand
          const top = c.high;
          const bottom = Math.min(c.open, c.close);
          return {
            price: top, // enter on retest of top edge
            zone: { top, bottom },
            model: "Breaker",
            stopAnchor: c.low,
          };
        }
      }
    }
    if (direction === "SELL" && isUpCandle) {
      for (let j = i + 1; j < candles.length; j++) {
        if (candles[j].close < c.low) {
          const bottom = c.low;
          const top = Math.max(c.open, c.close);
          return {
            price: bottom,
            zone: { top, bottom },
            model: "Breaker",
            stopAnchor: c.high,
          };
        }
      }
    }
  }
  return null;
}

// Judas sweep entry — session liquidity grab + 1H structure shift.
// Enter on retest of the CHoCH origin (the candle that closed back inside
// after the sweep). Stop beyond the swept wick.
function judasEntry(
  hourly: Candle[],
  direction: "BUY" | "SELL",
  atrVal: number,
): ProEntry | null {
  if (hourly.length < 30) return null;
  const hSwings = findSwings(hourly.slice(-60), 2);
  const sweep = findLiquiditySweep(hourly.slice(-60), hSwings, direction === "BUY" ? "Bullish" : "Bearish");
  if (!sweep) return null;
  // CHoCH origin = the candle at sweptAt (the one that reversed)
  const origin = hourly.slice(-60)[sweep.sweptAt];
  if (!origin) return null;
  const top = Math.max(origin.open, origin.close);
  const bottom = Math.min(origin.open, origin.close);
  const price = direction === "BUY" ? top : bottom; // retest edge
  const stopAnchor = direction === "BUY"
    ? sweep.level - atrVal * 0.3
    : sweep.level + atrVal * 0.3;
  return {
    price,
    zone: { top, bottom },
    model: "Judas",
    stopAnchor,
  };
}

// Pick the pro entry closest to current price (best pullback fill) that is
// within reach (≤ 2.5×ATR). If none qualify, return null (fall through to OB).
function pickBestProEntry(
  candidates: (ProEntry | null)[],
  currentPrice: number,
  atrVal: number,
): ProEntry | null {
  const viable = candidates.filter((e): e is ProEntry =>
    !!e && Math.abs(e.price - currentPrice) <= atrVal * 2.5,
  );
  if (!viable.length) return null;
  viable.sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice));
  return viable[0];
}

// ENTRY-TF CONFIRMATION CANDLE — a closed bar on the entry timeframe inside
// the zone with a rejection body in trade direction (body ≥ 40% of range).
function has1hConfirmation(
  hourly: Candle[],
  zone: EntryZone,
  direction: "BUY" | "SELL",
): boolean {
  const tail = hourly.slice(-6); // last few closed bars on entry TF
  for (const c of tail) {
    const inZone = c.low <= zone.top && c.high >= zone.bottom;
    if (!inZone) continue;
    const range = c.high - c.low;
    if (range <= 0) continue;
    const body = Math.abs(c.close - c.open);
    const bodyPct = body / range;
    const bullBody = c.close > c.open;
    const bearBody = c.close < c.open;
    // Close beyond zone midpoint in trade direction
    const zMid = (zone.top + zone.bottom) / 2;
    const closeStrong = direction === "BUY" ? c.close >= zMid : c.close <= zMid;
    if (bodyPct >= 0.4 && closeStrong && ((direction === "BUY" && bullBody) || (direction === "SELL" && bearBody))) {
      return true;
    }
  }
  return false;
}


// Attach the gate that stopped a setup from firing, so the UI can explain why
// a pair is "developing" instead of triggering.
function tagBlocked(d: DevelopingSetup | null, gate: string): DevelopingSetup | null {
  if (!d) return d;
  (d as DevelopingSetup & { blockedBy?: string }).blockedBy = gate;
  return d;
}

async function analyzePairFromCandles(
  pair: string,
  ltfRaw: Candle[],
  htfRaw: Candle[],
  hourly: Candle[], // entry-timeframe candles (15M forex / 5M indices+gold)
  opts?: { signalStyle?: "swing" | "scalp"; structureTf?: string; entryTf?: string },
): Promise<{ signal: Signal | null; developing: DevelopingSetup | null }> {
  const signalStyle = opts?.signalStyle ?? "swing";
  const structureTfLabel = opts?.structureTf ?? "4H";
  const entryTfName = opts?.entryTf ?? entryTfLabel(pair);


  const ltfTail = ltfRaw.slice(-200); // ~33 days of 4H
  const htfTail = htfRaw.slice(-150); // ~150 daily candles for stable bias

  if (ltfTail.length < 30) return { signal: null, developing: null };

  // 3-bar fractal — filters intraday noise on 4H
  const swings = findSwings(ltfTail, 2);
  const structure = analyzeStructure(ltfTail, swings);

  const htfCloses = htfTail.map((c) => c.close);
  if (htfCloses.length < 50) return { signal: null, developing: null };
  const ema20 = ema(htfCloses.slice(-40), 20);
  const ema50 = ema(htfCloses, 50);
  // Per-asset bias separation: tighter for FX (low daily vol), wider for crypto/indices.
  const biasSep = isCrypto(pair) ? 0.010 : (isIndex(pair) || isGold(pair)) ? 0.0035 : 0.0015;
  const htf_bias: "Bullish" | "Bearish" | "Neutral" =
    ema20 > ema50 * (1 + biasSep) ? "Bullish"
    : ema20 < ema50 * (1 - biasSep) ? "Bearish"
    : "Neutral";

  // 4H bias (from 4H closes) — must AGREE with Daily bias to define market direction.
  // Daily = macro trend, 4H = swing trend. Alignment of both = the "Market Direction"
  // filter the user asked for. 1H/30m is used below for the actual entry trigger.
  const ltfCloses = ltfTail.map((c) => c.close);
  const ltfEma20 = ema(ltfCloses.slice(-60), 20);
  const ltfEma50 = ema(ltfCloses, 50);
  const h4_bias: "Bullish" | "Bearish" | "Neutral" =
    ltfEma20 > ltfEma50 * (1 + biasSep * 0.6) ? "Bullish"
    : ltfEma20 < ltfEma50 * (1 - biasSep * 0.6) ? "Bearish"
    : "Neutral";
  const marketDirectionAligned =
    htf_bias !== "Neutral" && h4_bias === htf_bias;


  const lastCandle = ltfTail[ltfTail.length - 1];
  const currentPrice = lastCandle.close;
  const atrVal = atr(ltfTail, 14);

  // Volatility-expansion filter: if current ATR has collapsed vs the prior 30-bar
  // average, market is in a coil — SMC setups in that regime tend to chop and fail.
  const priorAtr = atr(ltfTail.slice(0, -10), 14);
  const volExpanding = priorAtr === 0 || atrVal >= priorAtr * 0.85;

  // News-driven momentum: last 4H candle range > 2x ATR (proxy for high-impact news)
  const lastRange = lastCandle.high - lastCandle.low;
  const newsMomentum = atrVal > 0 && lastRange > atrVal * 2;

  // ---------- DEVELOPING SETUP DETECTION ----------
  // We surface a pair as "developing" when bias is clear and at least one
  // smart-money trigger (sweep / OB / FVG) is present, but full signal isn't ready.
  const buildDeveloping = (): DevelopingSetup | null => {
    // Determine direction. Default = HTF bias. But if price is reacting from a
    // strong opposing daily S/R zone, surface that as a counter-trend bounce
    // (e.g. a BUY at strong support even when daily bias is Bearish).
    const dHtfZonesAll = findHTFZones(htfTail);
    const zoneTol = atrVal * 1.8;
    const nearSup = nearStrongZone(currentPrice, dHtfZonesAll, "support", zoneTol);
    const nearRes = nearStrongZone(currentPrice, dHtfZonesAll, "resistance", zoneTol);
    const closer =
      nearSup && nearRes
        ? Math.abs(currentPrice - nearSup.price) <= Math.abs(currentPrice - nearRes.price)
          ? { z: nearSup, dir: "BUY" as const, trend: "Bullish" as const }
          : { z: nearRes, dir: "SELL" as const, trend: "Bearish" as const }
        : nearSup
        ? { z: nearSup, dir: "BUY" as const, trend: "Bullish" as const }
        : nearRes
        ? { z: nearRes, dir: "SELL" as const, trend: "Bearish" as const }
        : null;

    let dir: "BUY" | "SELL";
    let trendDir: "Bullish" | "Bearish";
    let counterBias = false;
    let zoneReaction: { z: SRZone; dir: "BUY" | "SELL" } | null = null;
    if (closer) {
      dir = closer.dir;
      trendDir = closer.trend;
      counterBias = htf_bias !== "Neutral" && htf_bias !== trendDir;
      zoneReaction = { z: closer.z, dir: closer.dir };
    } else {
      if (htf_bias === "Neutral") return null;
      dir = htf_bias === "Bullish" ? "BUY" : "SELL";
      trendDir = htf_bias;
  }

    const dOb = findOrderBlock(ltfTail, structure.brokenAtIndex, trendDir);
    const dStacked = findStackedOBs(ltfTail, trendDir, atrVal);
    const dFreshOb = dOb && isFreshOB(ltfTail, dOb);
    const dMsbCount = countRecentMSBs(ltfTail, swings, trendDir, 50);
    const dFvg = findRecentFVG(ltfTail, trendDir);
    const dSweep = findLiquiditySweep(ltfTail, swings, trendDir);

    const triggers: string[] = [];
    let proximity = 20;
    if (dStacked.length === 2) {
      triggers.push(`★ Stacked ${trendDir.toLowerCase()} OBs — layered demand`);
      proximity += 30;
    } else if (dFreshOb && dOb) {
      triggers.push(`✓ Fresh ${dOb.type} OB (untested)`);
      proximity += 22;
    } else if (dOb) {
      triggers.push(`◌ ${dOb.type} OB (already tagged)`);
      proximity += 8;
    }
    if (dMsbCount >= 1) {
      triggers.push(`✓ ${dMsbCount}× ${trendDir} MSBs — trend confirmation`);
      proximity += dMsbCount >= 2 ? 15 : 10;
    }
    if (dSweep) { triggers.push(`✓ Liquidity sweep @ ${dSweep.level.toFixed(priceDecimals(pair))}`); proximity += 15; }
    if (dFvg) { triggers.push(`✓ ${dFvg.type} FVG imbalance`); proximity += 8; }
    if (structure.structure) {
      triggers.push(`✓ ${structure.structure} on 4H (${structure.trend})`);
      proximity += 10;
    } else {
      triggers.push(`◌ Waiting for BOS/CHoCH break`);
    }
    if (newsMomentum) { triggers.push(`⚡ News-driven momentum candle`); proximity += 8; }
    if (zoneReaction) {
      const label = zoneReaction.dir === "BUY" ? "support" : "resistance";
      triggers.push(
        `★ Reacting from strong daily ${label} @ ${zoneReaction.z.price.toFixed(priceDecimals(pair))} (${zoneReaction.z.touches}× touches)`,
      );
      proximity += 20;
      if (counterBias) {
        triggers.push(`⚠ Counter-bias bounce — daily HTF is ${htf_bias}`);
      }
    }

    // Surface if we have a strong zone reaction OR any other smart-money trigger.
    if (!zoneReaction && !dSweep && !dOb && !newsMomentum && dStacked.length === 0) return null;

    let reason = "";
    if (newsMomentum && !structure.structure) reason = "News spike — waiting for structure break";
    else if (dSweep && !structure.structure) reason = "Liquidity swept — waiting for BOS confirmation";
    else if (dOb && !structure.structure) reason = "Order block tagged — waiting for reaction";
    else if (structure.structure && !dSweep && !dOb) reason = "Structure break — waiting for OB/sweep entry";
    else reason = "Multiple confluences building — close to firing";

    // Compute a proposed trade plan (entry / SL / TP zones) using the same
    // structure-anchored model as confirmed signals: SL beyond protective swing,
    // TP1 at nearest opposing swing, TP2 at next HTF zone.
    const decimals = priceDecimals(pair);
    const p = pip(pair);
    let plan: DevelopingSetup["plan"] = null;

    let pEntry: number | null = null;
    let pSL: number | null = null;
    let obEdge: number | null = null;
    if (dStacked.length === 2) {
      const closest = dir === "BUY"
        ? dStacked.reduce((a, b) => (Math.abs(currentPrice - a.top) < Math.abs(currentPrice - b.top) ? a : b))
        : dStacked.reduce((a, b) => (Math.abs(currentPrice - a.bottom) < Math.abs(currentPrice - b.bottom) ? a : b));
      pEntry = dir === "BUY" ? closest.top : closest.bottom;
      obEdge = dir === "BUY"
        ? Math.min(...dStacked.map((o) => o.bottom))
        : Math.max(...dStacked.map((o) => o.top));
    } else if (dOb) {
      pEntry = (dOb.top + dOb.bottom) / 2;
      obEdge = dir === "BUY" ? dOb.bottom : dOb.top;
    } else if (dSweep) {
      pEntry = dSweep.level;
      obEdge = dSweep.level;
    } else if (zoneReaction) {
      // Counter-bias bounce off raw HTF level: enter at the zone, SL beyond it.
      pEntry = zoneReaction.z.price;
      obEdge = zoneReaction.z.price;
    }
    if (pEntry != null && obEdge != null) {
      pSL = structuralStop(ltfTail, swings, dir, obEdge, atrVal, 30);
      const maxRisk = atrVal * 3;
      if (Math.abs(pEntry - pSL) > maxRisk) {
        pSL = dir === "BUY" ? pEntry - maxRisk : pEntry + maxRisk;
      }
    }

    if (pEntry != null && pSL != null) {
      const risk = Math.abs(pEntry - pSL);
      // Informational zones — accept any non-zero risk (the strict minRisk gate
      // is enforced only when a confirmed signal fires).
      if (risk > 0) {
        const dHtfZones = findHTFZones(htfTail);
        const minT1 = risk * 1.5;
        const minT2 = risk * 3;
        const maxT1 = risk * 4;
        const maxT2 = risk * 8;
        const sw = nearestOpposingSwing(swings, dir, pEntry, minT1);
        const zo = nextHTFZone(dHtfZones, dir, pEntry, minT2);
        const clmp = (target: number, lo: number, hi: number) =>
          dir === "BUY"
            ? Math.min(Math.max(target, pEntry! + lo), pEntry! + hi)
            : Math.max(Math.min(target, pEntry! - lo), pEntry! - hi);
        const tp1 = sw != null
          ? clmp(sw, minT1, maxT1)
          : dir === "BUY" ? pEntry + risk * 2 : pEntry - risk * 2;
        const tp1Dist = Math.abs(tp1 - pEntry);
        const minT2F = Math.max(minT2, tp1Dist + risk * 0.5);
        const tp2 = zo != null
          ? clmp(zo, minT2F, maxT2)
          : dir === "BUY" ? pEntry + risk * 5 : pEntry - risk * 5;
        const riskPips = toPips(pair, risk);

        // ---- Deeper SWING entry tier ----
        // Use the daily HTF zone (support for BUY / resistance for SELL) as a
        // discount/premium fill. Falls back to nearest opposing HTF zone if no
        // current reaction was tagged. Only emitted when meaningfully deeper
        // than the LTF entry (>= 0.5×ATR away) so we don't duplicate it.
        let swingEntry: number | undefined;
        let swingStopLoss: number | undefined;
        let swingRiskPips: number | undefined;
        const dailyZone =
          zoneReaction?.z ??
          dHtfZones
            .filter((z) =>
              dir === "BUY"
                ? z.type === "support" && z.price < pEntry!
                : z.type === "resistance" && z.price > pEntry!,
            )
            .sort((a, b) => Math.abs(a.price - pEntry!) - Math.abs(b.price - pEntry!))[0];
        if (dailyZone) {
          const candidate = dailyZone.price;
          const gap = Math.abs(candidate - pEntry);
          const inDirection = dir === "BUY" ? candidate < pEntry : candidate > pEntry;
          if (inDirection && gap >= atrVal * 0.5) {
            const slBuffer = Math.max(atrVal * 1.2, p * 8);
            const sSL = dir === "BUY" ? candidate - slBuffer : candidate + slBuffer;
            const sRisk = Math.abs(candidate - sSL);
            if (sRisk > 0) {
              swingEntry = Number(candidate.toFixed(decimals));
              swingStopLoss = Number(sSL.toFixed(decimals));
              swingRiskPips = Math.round(toPips(pair, sRisk));
            }
          }
        }

        plan = {
          entry: Number(pEntry.toFixed(decimals)),
          stopLoss: Number(pSL.toFixed(decimals)),
          takeProfit: Number(tp1.toFixed(decimals)),
          takeProfit2: Number(tp2.toFixed(decimals)),
          riskPips: Math.round(riskPips),
          ...(swingEntry != null
            ? { swingEntry, swingStopLoss, swingRiskPips }
            : {}),
        };
      }
    }

    return {
      pair,
      direction: dir,
      htf_bias: trendDir,
      reason,
      proximity: Math.min(95, proximity),
      currentPrice: Number(currentPrice.toFixed(decimals)),
      newsMomentum,
      triggers,
      plan,
    };
  };

  // ---------- FULL SIGNAL DETECTION ----------
  // 90%-grade gates: BOS only (no CHoCH), HTF-aligned, at strong daily S/R,
  // confirmed by retest + (RSI bias OR engulfing).
  if (!structure.structure) {
    return { signal: null, developing: tagBlocked(buildDeveloping(), "NO_4H_STRUCTURE") };
  }

  // Bias relaxations are scored, not hard-blocked. A textbook triple-aligned
  // setup keeps full confidence; softer variants fire with a penalty so the
  // engine still produces trades in mixed-bias markets.
  let biasPenalty = 0;

  if (structure.trend === "Neutral") {
    return { signal: null, developing: tagBlocked(buildDeveloping(), "NO_4H_STRUCTURE") };
  }

  // Direction starts from the 4H structural break…
  let direction: "BUY" | "SELL" = structure.trend === "Bullish" ? "BUY" : "SELL";

  // GATE 3: must be reacting from a STRONG daily S/R zone (≥2 touches). This is
  // the "buy strong support and ride it" core rule — the only hard requirement.
  const htfZones = findHTFZones(htfTail);
  const zoneTol = atrVal * 1.8;
  const zoneFor = (d: "BUY" | "SELL") =>
    nearStrongZone(currentPrice, htfZones, d === "BUY" ? "support" : "resistance", zoneTol);

  let strongZone = zoneFor(direction);
  if (!strongZone) {
    // …but never sell into strong support / buy into strong resistance. If the
    // opposing zone is the one price is reacting from, take the bounce instead
    // (penalised counter-structure reversal).
    const flipped: "BUY" | "SELL" = direction === "BUY" ? "SELL" : "BUY";
    const flipZone = zoneFor(flipped);
    if (!flipZone) return { signal: null, developing: tagBlocked(buildDeveloping(), "GATE 3") };
    direction = flipped;
    strongZone = flipZone;
    biasPenalty += 12;
  }

  const dirBias: "Bullish" | "Bearish" = direction === "BUY" ? "Bullish" : "Bearish";
  const trendDir = dirBias;

  // Neutral daily bias: allowed at a strong zone, penalised harder when 4H
  // doesn't agree with the trade direction either.
  if (htf_bias === "Neutral") {
    biasPenalty += h4_bias === dirBias ? 6 : 12;
  }

  // GATE 1: CHoCH allowed only as a reversal off a strong zone (penalised).
  if (structure.structure !== "BOS") biasPenalty += 6;

  // GATE 2: counter-daily-bias entries allowed only as zone bounces (penalised).
  const aligned = htf_bias === "Neutral" || htf_bias === dirBias;
  if (!aligned) biasPenalty += 10;

  // GATE 2b: 4H bias divergence from the trade direction — soft penalty.
  if (h4_bias !== dirBias) biasPenalty += 8;
  if (!marketDirectionAligned) biasPenalty += 4;



  const obAnchor = findOrderBlock(ltfTail, structure.brokenAtIndex, trendDir);
  const stackedOBs = findStackedOBs(ltfTail, trendDir, atrVal);
  const allFreshOBs = findAllOrderBlocks(ltfTail, trendDir, 60)
    .filter((o) => isFreshOB(ltfTail, o));

  const fvg = findRecentFVG(ltfTail, trendDir);
  const sweep = findLiquiditySweep(ltfTail, swings, trendDir);

  // GATE 4: must have a FRESH (untested) OB. Prefer stacked, fall back to anchor.
  let ob: OrderBlock | null = null;
  let isStacked = false;
  if (stackedOBs.length === 2) {
    ob = direction === "BUY"
      ? stackedOBs.reduce((a, b) => (Math.abs(currentPrice - a.top) < Math.abs(currentPrice - b.top) ? a : b))
      : stackedOBs.reduce((a, b) => (Math.abs(currentPrice - a.bottom) < Math.abs(currentPrice - b.bottom) ? a : b));
    isStacked = true;
  } else if (obAnchor && isFreshOB(ltfTail, obAnchor)) {
    ob = obAnchor;
  } else if (allFreshOBs.length > 0) {
    ob = allFreshOBs[allFreshOBs.length - 1];
  }
  if (!ob) return { signal: null, developing: tagBlocked(buildDeveloping(), "GATE 4") };

  // GATE 5: price must be APPROACHING or INSIDE the OB (within 2.5×ATR).
  // No point firing "buy" if price is 200 pips above the demand zone.
  const distanceToOB = direction === "BUY"
    ? currentPrice - ob.top
    : ob.bottom - currentPrice;
  const maxApproach = atrVal * 2.5;
  if (distanceToOB > maxApproach) {
    return { signal: null, developing: tagBlocked(buildDeveloping(), "GATE 5") };
  }

  // GATE 6 (soft): same-direction MSBs confirm the structural shift. A zone
  // reversal often has none yet — penalise instead of silencing the setup.
  const msbCount = countRecentMSBs(ltfTail, swings, trendDir, 50);

  // Soft-gate penalty accumulator. Confluence factors that used to hard-reject
  // now cost confidence instead — the 72% floor still filters weak setups, but
  // one missing ingredient no longer silences the whole scanner.
  let qualityPenalty = biasPenalty;
  if (msbCount < 1) qualityPenalty += 10;

  // GATE 7 (soft): BOS retest of the flipped level.
  const retestTol = atrVal * 0.75;
  const retested =
    structure.brokenLevel != null && structure.brokenAtIndex != null
      ? hasRetested(ltfTail, structure.brokenLevel, structure.brokenAtIndex, retestTol)
      : false;
  if (!retested) qualityPenalty += 8;

  // GATE 8: momentum confirmation (RSI bias OR engulfing on last 4H candle)
  const rsiVal = rsi(ltfTail, 14);
  const engulf = isEngulfing(ltfTail, trendDir);
  const rsiOk = direction === "BUY" ? rsiVal > 50 : rsiVal < 50;
  if (!rsiOk && !engulf) qualityPenalty += 10;

  // GATE 9 (soft, DAX-style): displacement candle in trend direction.
  const displaced = hasDisplacement(ltfTail, trendDir, atrVal, 5);
  if (!displaced) qualityPenalty += 6;

  // GATE 10 (soft, DAX-style): Asian liquidity sweep + kill-zone timing.
  // Crypto trades 24/7 (no Asian session model) — no penalty for BTC/ETH.
  const aRange = asianRange(hourly);
  const aSweep = aRange ? asianSweep(hourly, aRange, trendDir, 12) : null;
  const kz = inKillZone(lastCandle.time);
  if (!isCrypto(pair) && !aSweep && !kz.active) qualityPenalty += 5;

  // GATE 10-A (HARD): LIQUIDITY SWEEP REQUIREMENT.
  // Institutional entries are preceded by a stop-run: price must have taken out
  // a prior swing high/low (or the Asian range) before we accept the structure
  // break. Without a sweep, a BOS is far more likely to be a fakeout.
  const sweptLiquidity = !!sweep || !!aSweep;
  if (!sweptLiquidity) {
    return { signal: null, developing: tagBlocked(buildDeveloping(), "GATE 10-A (no liquidity sweep)") };
  }

  // GATE 10-B (HARD): PER-INSTRUMENT SESSION FILTER.
  // FX only in the London–NY window, each index only in its own cash session,
  // crypto always. Outside those windows spreads widen and follow-through dies.
  {
    const sess = inTradingSession(pair, new Date());
    if (!sess.ok) {
      return { signal: null, developing: tagBlocked(buildDeveloping(), `GATE 10-B (outside ${sess.label})`) };
    }
  }

  // GATE 10-C (HARD): HIGH-IMPACT NEWS BLACKOUT — no entries ±35 min around
  // the recurring US data / FOMC release windows.
  {
    const nb = inNewsBlackout(pair, new Date());
    if (nb.blocked) {
      return { signal: null, developing: tagBlocked(buildDeveloping(), `GATE 10-C (${nb.label})`) };
    }
  }


  // GATE 10b (soft): volatility should be expanding — coiled markets chop.
  if (!volExpanding) qualityPenalty += 6;

  // GATE 10c: avoid weekend gap risk for FX. No new FX entries after Fri 19:00 UTC
  // or before Sun 22:00 UTC. Crypto trades 24/7, indices have own session — skip.
  if (!isCrypto(pair) && !isIndex(pair) && !isGold(pair)) {
    const now = new Date();
    const dow = now.getUTCDay(); // 0=Sun, 5=Fri, 6=Sat
    const h = now.getUTCHours();
    const weekendBlocked =
      dow === 6 ||
      (dow === 5 && h >= 19) ||
      (dow === 0 && h < 22);
    if (weekendBlocked) return { signal: null, developing: tagBlocked(buildDeveloping(), "GATE 10c") };
  }

  // GATE 10c-2: avoid FX daily rollover (20:00–22:00 UTC) — spreads widen 5–10×,
  // stop-runs are common, and fills are unreliable. Crypto/indices unaffected.
  if (!isCrypto(pair) && !isIndex(pair) && !isGold(pair)) {
    const rolloverH = new Date().getUTCHours();
    if (rolloverH >= 20 && rolloverH < 22) {
      return { signal: null, developing: tagBlocked(buildDeveloping(), "GATE 10c-2") };
    }
  }

  // GATE 10c-3: MARKET REGIME — reject post-news whipsaw and dead markets.
  // Compare current ATR to the prior baseline. Healthy band = 0.6×–2.5×.
  //  • Below 0.6× = comatose, BOS likely fake, no follow-through.
  //  • Above 2.5× = post-news chaos, spreads blown out, fills unreliable.
  {
    const baselineWindow = ltfTail.slice(-100, -14);
    if (baselineWindow.length >= 30) {
      const baselineAtr = atr(baselineWindow, 14);
      if (baselineAtr > 0) {
        const ratio = atrVal / baselineAtr;
        // Regime quality is scored, never a hard block: dead or blown-out
        // volatility costs confidence and the 72% floor does the filtering.
        if (ratio < 0.45 || ratio > 3.2) qualityPenalty += 16;
        else if (ratio < 0.6 || ratio > 2.5) qualityPenalty += 8;
      }
    }
  }

  // GATE 10c-4: TREND QUALITY — reject pure ranges. Require ≥40% of the last
  // ~20 closes to step in trade direction. Below that = chop, edge collapses.
  {
    const recent = ltfTail.slice(-20);
    if (recent.length >= 15) {
      let alignedCloses = 0;
      for (let i = 1; i < recent.length; i++) {
        const up = recent[i].close > recent[i - 1].close;
        if ((direction === "BUY" && up) || (direction === "SELL" && !up)) {
          alignedCloses++;
        }
      }
      if (alignedCloses / (recent.length - 1) < 0.3) {
        return { signal: null, developing: tagBlocked(buildDeveloping(), "GATE 10c-4") };
      }
    }
  }

  const p = pip(pair);

  // ---- ORDER BLOCK ENTRY (only model used) ----
  // Professional OB execution: fill at the block's mean threshold (50% of the
  // OB body range) rather than the proximal edge — better average price, still
  // inside the institutional zone. If price has already traded past the mean,
  // fall back to the proximal edge so the entry remains reachable.
  const obZone: EntryZone = { top: ob.top, bottom: ob.bottom };
  const obProximal = direction === "BUY" ? ob.top : ob.bottom;
  const obMean = (ob.top + ob.bottom) / 2;
  const meanReachable = direction === "BUY" ? currentPrice > obMean : currentPrice < obMean;
  const entry = Number((meanReachable ? obMean : obProximal).toFixed(priceDecimals(pair)));
  const entryZone: EntryZone = obZone;
  const entryModel: "OTE" | "FVG" | "Breaker" | "Judas" | "OB" = "OB";


  // GATE 10d: DISCOUNT/PREMIUM filter (SMC OTE range).
  // Entry must sit in the discount half (BUY) / premium half (SELL) of the
  // recent 60-bar dealing range — never enter at parity or worse.
  const rangeWindow = ltfTail.slice(-60);
  const rangeHigh = Math.max(...rangeWindow.map((c) => c.high));
  const rangeLow = Math.min(...rangeWindow.map((c) => c.low));
  const rangeMid = (rangeHigh + rangeLow) / 2;
  const rangeSize = Math.max(rangeHigh - rangeLow, 1e-9);
  const offMid = direction === "BUY" ? (entry - rangeMid) / rangeSize : (rangeMid - entry) / rangeSize;
  // Deep in the wrong half is a hard reject; marginally past parity is penalised.
  if (offMid > 0.12) return { signal: null, developing: tagBlocked(buildDeveloping(), "GATE 10d") };
  if (offMid > 0) qualityPenalty += 8;

  // GATE 10d-2: 1H CONFIRMATION CANDLE — the pro-entry trigger.
  // We no longer fire on a passive limit; require a closed 1H bar inside the
  // entry zone with a rejection body in trade direction. Trade is executed
  // MARKET-ON-CLOSE of that confirmation candle. Auto-trigger (≥95%) skips.
  const confirmedByCandle = has1hConfirmation(hourly, entryZone, direction);



  // ---- STOP LOSS: just beyond the STRONG HTF zone we're reacting from ----
  // Per the playbook: "set SL below the support". We anchor the stop to the
  // far side of the strong daily S/R zone (the actual invalidation level for
  // the thesis), padded by a 0.75×ATR wick-noise buffer. We also compute the
  // OB-structural SL and take whichever is DEEPER — so the stop is never
  // tighter than real structure (avoids stop-runs on noise) while still
  // capped at 3×ATR so risk stays realistic.
  let obEdge = direction === "BUY" ? ob.bottom : ob.top;
  if (isStacked) {
    obEdge = direction === "BUY"
      ? Math.min(...stackedOBs.map((o) => o.bottom))
      : Math.max(...stackedOBs.map((o) => o.top));
  }
  const structSL = structuralStop(ltfTail, swings, direction, obEdge, atrVal, 30);
  const zoneBuffer = atrVal * 0.75;
  const zoneSL = direction === "BUY"
    ? strongZone.price - zoneBuffer
    : strongZone.price + zoneBuffer;
  // Deeper of the two = safer invalidation
  let stopLoss = direction === "BUY"
    ? Math.min(structSL, zoneSL)
    : Math.max(structSL, zoneSL);

  // If a liquidity sweep exists, only use the swept wick as SL when it's
  // STILL beyond the strong zone (don't tighten inside the support we trust).
  if (sweep) {
    const sweepSL = direction === "BUY" ? sweep.level - atrVal * 0.5 : sweep.level + atrVal * 0.5;
    const beyondZone = direction === "BUY" ? sweepSL < zoneSL : sweepSL > zoneSL;
    if (beyondZone) {
      stopLoss = direction === "BUY" ? Math.min(stopLoss, sweepSL) : Math.max(stopLoss, sweepSL);
    }
  }

  // OB INVALIDATION FLOOR — a professional OB stop always sits beyond the
  // distal edge of the block (plus a 0.35×ATR wick buffer). If price closes
  // through the block the setup is dead, so never place the stop inside it.
  const obFloorSL = direction === "BUY"
    ? obEdge - atrVal * 0.35
    : obEdge + atrVal * 0.35;
  stopLoss = direction === "BUY"
    ? Math.min(stopLoss, obFloorSL)
    : Math.max(stopLoss, obFloorSL);

  // Cap risk at 3×ATR — anything wider isn't a swing entry, it's a hope trade.
  const maxRisk = atrVal * 3;
  if (Math.abs(entry - stopLoss) > maxRisk) {
    stopLoss = direction === "BUY" ? entry - maxRisk : entry + maxRisk;
  }

  const risk = Math.abs(entry - stopLoss);
  if (risk < minRiskFor(pair, atrVal)) return { signal: null, developing: tagBlocked(buildDeveloping(), "GATE 10d-2") };

  // ---- TAKE PROFITS: ride from support to the top ----
  // TP1 = first realistic obstacle (nearest opposing 4H swing OR opposing
  //   HTF zone, whichever comes first). 1.5R floor, 4R cap → bankable partial.
  // TP2 = the STRONGEST opposing HTF zone within reach (the "top of the
  //   move"). 3R floor, 10R cap → captures the full ride when structure allows.
  const minTP1 = risk * 1.5;
  // TP1 is the bankable partial; TP2 is a runner. Cap runner tighter on crypto
  // so BTC/ETH don't show inflated 8–10R "risk_reward" on every setup.
  const maxTP1 = risk * 3;
  const minTP2 = risk * 2.5;
  const maxTP2 = isCrypto(pair) ? risk * 5 : risk * 6;

  const opposingType: SRZone["type"] = direction === "BUY" ? "resistance" : "support";
  // All opposing HTF zones beyond entry, sorted nearest → farthest
  const opposingZones = htfZones
    .filter((z) => z.type === opposingType)
    .filter((z) => direction === "BUY" ? z.price > entry : z.price < entry)
    .sort((a, b) =>
      direction === "BUY" ? a.price - b.price : b.price - a.price,
    );

  const swingTP = nearestOpposingSwing(swings, direction, entry, minTP1);
  // Nearest opposing HTF zone — first obstacle on the way up
  const nearestZone = opposingZones[0]?.price ?? null;
  // Strongest opposing HTF zone within max reach — the "top" target
  const reachLimit = direction === "BUY" ? entry + maxTP2 : entry - maxTP2;
  const inReach = opposingZones.filter((z) =>
    direction === "BUY" ? z.price <= reachLimit : z.price >= reachLimit,
  );
  const strongestZone = inReach.length > 0
    ? inReach.reduce((best, z) => (z.touches > best.touches ? z : best)).price
    : opposingZones[opposingZones.length - 1]?.price ?? null;

  const clamp = (target: number, lo: number, hi: number) =>
    direction === "BUY"
      ? Math.min(Math.max(target, entry + lo), entry + hi)
      : Math.max(Math.min(target, entry - lo), entry - hi);

  // TP1: first obstacle (whichever is nearer — swing or zone)
  const tp1Candidates = [swingTP, nearestZone].filter((v): v is number => v != null);
  const tp1Raw = tp1Candidates.length > 0
    ? (direction === "BUY" ? Math.min(...tp1Candidates) : Math.max(...tp1Candidates))
    : null;
  const takeProfit = tp1Raw != null
    ? clamp(tp1Raw, minTP1, maxTP1)
    : direction === "BUY" ? entry + risk * 2 : entry - risk * 2;

  // TP2 must be beyond TP1; aim for the strongest zone (the top), default 6R
  const tp1Distance = Math.abs(takeProfit - entry);
  const minTP2Final = Math.max(minTP2, tp1Distance + risk * 0.5);
  const takeProfit2 = strongestZone != null
    ? clamp(strongestZone, minTP2Final, maxTP2)
    : direction === "BUY" ? entry + risk * (isCrypto(pair) ? 4 : 5) : entry - risk * (isCrypto(pair) ? 4 : 5);

  const rr1 = Number((Math.abs(takeProfit - entry) / risk).toFixed(2));
  const rr2 = Number((Math.abs(takeProfit2 - entry) / risk).toFixed(2));

  // ---------- CONFIDENCE BREAKDOWN ----------
  // Each factor records: label, point value, hit/miss. The UI shows this
  // breakdown so the trader sees *why* the score is what it is.
  const confluences: string[] = [];
  const breakdown: ConfidenceFactor[] = [];
  let confidence = 25;
  const add = (label: string, points: number, hit: boolean, confluence?: string) => {
    breakdown.push({ label, points, hit });
    if (hit) {
      confidence += points;
      if (confluence) confluences.push(confluence);
    }
  };

  add("Base score", 25, true);
  add("BOS + retest on 4H", 10, true, `BOS on 4H — break and retest confirmed`);
  {
    const pctFromMid = ((entry - rangeMid) / (rangeHigh - rangeLow)) * 100;
    const zoneLabel = direction === "BUY"
      ? `discount (${Math.abs(pctFromMid).toFixed(0)}% below mid)`
      : `premium (${Math.abs(pctFromMid).toFixed(0)}% above mid)`;
    add("Discount/premium entry", 6, true, `Entry in ${zoneLabel} of 60-bar range`);
  }
  add(
    `Strong D1 ${direction === "BUY" ? "support" : "resistance"} (${strongZone.touches} touches)`,
    14,
    true,
    `Strong ${direction === "BUY" ? "support" : "resistance"} zone @ ${strongZone.price.toFixed(priceDecimals(pair))} (${strongZone.touches} touches on D1)`,
  );
  add(
    isStacked ? "★ Stacked Order Blocks" : "Fresh Order Block",
    isStacked ? 20 : 12,
    true,
    isStacked
      ? `★ STACKED ${ob.type} order blocks — layered demand zone`
      : `Fresh ${ob.type} 4H Order Block (untested)`,
  );
  const msbPoints = Math.min(12, msbCount * 4);
  add(`${msbCount}× ${trendDir} MSBs`, msbPoints, true, `${msbCount}× ${trendDir} MSBs — sustained trend`);
  add("Daily bias aligned", 8, true, `Daily bias aligned: ${htf_bias}`);
  add("4H bias confirms Daily", 8, h4_bias === dirBias, `4H bias ${h4_bias} confirms Daily ${htf_bias} — market direction locked`);

  add("Displacement candle", 6, true, `Displacement candle confirms smart-money entry`);

  add(
    "FVG imbalance",
    5,
    !!fvg,
    fvg ? `${fvg.type === "bullish" ? "Bullish" : "Bearish"} FVG (imbalance)` : undefined,
  );
  add(
    "Liquidity sweep",
    10,
    !!sweep,
    sweep ? `Liquidity sweep of ${sweep.level.toFixed(priceDecimals(pair))} (stop hunt)` : undefined,
  );
  add(
    "Engulfing entry candle",
    6,
    engulf,
    engulf ? `${trendDir} engulfing on entry candle` : undefined,
  );
  add(
    `RSI ${rsiVal.toFixed(0)} confirms direction`,
    4,
    rsiOk,
    rsiOk ? `RSI ${rsiVal.toFixed(0)} confirms ${direction} momentum` : undefined,
  );
  add(
    "News-driven momentum",
    4,
    newsMomentum,
    newsMomentum ? `⚡ News-driven momentum candle (>2x ATR)` : undefined,
  );
  add(
    "Asian range swept",
    6,
    !!aSweep,
    aSweep ? `Asian range ${direction === "BUY" ? "low" : "high"} swept @ ${aSweep.swept.toFixed(priceDecimals(pair))}` : undefined,
  );
  add(
    `${kz.session ?? "Kill"}-zone timing`,
    5,
    kz.active,
    kz.active ? `${kz.session} kill-zone — institutional volume window` : undefined,
  );

  const pips = toPips(pair, risk);
  const modelLabel = "Order block · mean threshold (50% of OB)";
  confluences.push(`Pro entry model: ${modelLabel} · Market-on-1H-confirmation`);
  confluences.push(
    `Risk: ${pips.toFixed(0)} pips · TP1: ${(pips * rr1).toFixed(0)} pips (${rr1}R) · TP2: ${(pips * rr2).toFixed(0)} pips (${rr2}R)`,
  );


  confidence = Math.max(20, Math.min(98, confidence - qualityPenalty));

  // GATE 11: A-grade floor — 72% after soft-gate penalties
  if (confidence < 72) return { signal: null, developing: tagBlocked(buildDeveloping(), "GATE 11") };

  const decimals = priceDecimals(pair);

  // ---- Deeper SWING entry tier ----
  // Mirror the developing-setup logic: the daily HTF zone (strongZone) is the
  // true discount/premium fill. Only attach when it's meaningfully deeper than
  // the LTF entry (>= 0.5×ATR away in the trade direction).
  let swingEntry: number | undefined;
  let swingStopLoss: number | undefined;
  let swingRiskPips: number | undefined;
  {
    const candidate = strongZone.price;
    const inDirection = direction === "BUY" ? candidate < entry : candidate > entry;
    const gap = Math.abs(candidate - entry);
    if (inDirection && gap >= atrVal * 0.5) {
      const slBuffer = Math.max(atrVal * 1.2, p * 8);
      const sSL = direction === "BUY" ? candidate - slBuffer : candidate + slBuffer;
      const sRisk = Math.abs(candidate - sSL);
      if (sRisk > 0) {
        swingEntry = Number(candidate.toFixed(decimals));
        swingStopLoss = Number(sSL.toFixed(decimals));
        swingRiskPips = Math.round(toPips(pair, sRisk));
      }
    }
  }

  // ---- Split-entry smoothing (50/50 LTF + swing) ----
  let splitEntry:
    | { tier1: number; tier2: number; allocation: number; blendedEntry: number; blendedRiskPips: number }
    | undefined;
  if (swingEntry != null && swingStopLoss != null) {
    const blended = (entry + swingEntry) / 2;
    const blendedRisk = Math.abs(blended - swingStopLoss);
    splitEntry = {
      tier1: Number(entry.toFixed(decimals)),
      tier2: swingEntry,
      allocation: 0.5,
      blendedEntry: Number(blended.toFixed(decimals)),
      blendedRiskPips: Math.round(toPips(pair, blendedRisk)),
    };
  }

  // ---- Entry-TF trigger (15M forex / 5M indices+gold) ----
  // Market direction (Daily+4H) is confirmed above. Now require the entry TF
  // to have shifted in our direction (BOS/CHoCH) for precision timing.
  const hTail = hourly.slice(-120);
  let ltfConfirmed = false;
  let ltfStructureType: "BOS" | "CHoCH" | null = null;
  const wantTrend = direction === "BUY" ? "Bullish" : "Bearish";
  if (hTail.length >= 30) {
    const hSwings = findSwings(hTail, 2);
    const hStruct = analyzeStructure(hTail, hSwings);
    if (hStruct.trend === wantTrend && hStruct.structure != null) {
      ltfConfirmed = true;
      ltfStructureType = hStruct.structure;
    }
  }
  const proTriggerReady = ltfConfirmed || confirmedByCandle;
  if (!proTriggerReady && confidence < 90) {
    return { signal: null, developing: tagBlocked(buildDeveloping(), "GATE 11") };
  }

  if (ltfConfirmed && ltfStructureType) {
    confluences.push(`✓ ${ltfStructureType} on ${entryTfName} (entry TF)`);
  } else if (confirmedByCandle) {
    confluences.push(`✓ ${entryTfName} confirmation candle in zone`);
  }
  confluences.push(`Structure ${structureTfLabel} · Entry ${entryTfName}`);

  return {
    signal: {
      pair,
      direction,
      entry: Number(entry.toFixed(decimals)),
      stopLoss: Number(stopLoss.toFixed(decimals)),
      takeProfit: Number(takeProfit.toFixed(decimals)),
      takeProfit2: Number(takeProfit2.toFixed(decimals)),
      riskReward: rr1,  // TP1 R — actual book PnL uses close_price
      confidence,
      structure: structure.structure,
      confluences,
      confidenceBreakdown: breakdown,
      currentPrice: Number(currentPrice.toFixed(decimals)),
      timestamp: new Date(lastCandle.time * 1000).toISOString(),
      htf_bias,
      ...(swingEntry != null ? { swingEntry, swingStopLoss, swingRiskPips } : {}),
      ...(splitEntry ? { splitEntry } : {}),
      ltfConfirmed: confidence >= 90 ? true : ltfConfirmed,
      awaitingLtfConfirmation: confidence >= 90 ? false : !ltfConfirmed,
      autoTrigger: confidence >= 90,
      entryModel,
      entryTrigger: "MARKET_ON_CONFIRMATION",
      entryZone: {
        top: Number(entryZone.top.toFixed(decimals)),
        bottom: Number(entryZone.bottom.toFixed(decimals)),
      },
      signalStyle,
      structureTimeframe: structureTfLabel,
      entryTimeframe: entryTfName,
    },
    developing: null,

  };
}


// ---------- GOLD SCALP: 1H trend + 5M BOS entry ----------
// Separate from the swing path. Only runs for XAU/USD.
async function analyzeGoldScalp(
  pair: string,
  hourly: Candle[],
  fiveMin: Candle[],
): Promise<Signal | null> {
  if (!isGold(pair)) return null;
  if (hourly.length < 40 || fiveMin.length < 40) return null;

  const hTail = hourly.slice(-120);
  const mTail = fiveMin.slice(-120);
  const hSwings = findSwings(hTail, 2);
  const hStruct = analyzeStructure(hTail, hSwings);
  if (!hStruct.structure || hStruct.trend === "Neutral") return null;

  const direction: "BUY" | "SELL" = hStruct.trend === "Bullish" ? "BUY" : "SELL";
  const wantTrend = hStruct.trend;

  const mSwings = findSwings(mTail, 2);
  const mStruct = analyzeStructure(mTail, mSwings);
  // Require a clear 5M BOS (prefer BOS over CHoCH for scalps)
  if (mStruct.trend !== wantTrend || mStruct.structure !== "BOS") return null;

  const last = mTail[mTail.length - 1];
  const currentPrice = last.close;
  const atrVal = atr(mTail, 14);
  if (atrVal <= 0) return null;

  // Prefer entry on retest of the 5M OB created by the break
  const mObs = findOrderBlocks(mTail, mSwings).filter((o) =>
    direction === "BUY" ? o.type === "bullish" : o.type === "bearish",
  );
  const recentOb = mObs.length ? mObs[mObs.length - 1] : null;
  const decimals = priceDecimals(pair);
  let entry: number;
  let entryZone: { top: number; bottom: number };
  let entryModel: "OTE" | "FVG" | "Breaker" | "Judas" | "OB" = "OB";

  if (recentOb) {
    const mean = (recentOb.top + recentOb.bottom) / 2;
    const proximal = direction === "BUY" ? recentOb.top : recentOb.bottom;
    const meanReachable = direction === "BUY" ? currentPrice > mean : currentPrice < mean;
    entry = Number((meanReachable ? mean : proximal).toFixed(decimals));
    entryZone = { top: recentOb.top, bottom: recentOb.bottom };
  } else {
    // Fallback: enter near current price with tight ATR stop
    entry = Number(currentPrice.toFixed(decimals));
    const pad = atrVal * 0.3;
    entryZone = {
      top: direction === "BUY" ? currentPrice + pad : currentPrice,
      bottom: direction === "BUY" ? currentPrice : currentPrice - pad,
    };
    entryModel = "Breaker";
  }

  // Scalp risk: 1.0× 5M ATR beyond zone
  const slBuffer = atrVal * 1.0;
  const stopLoss = Number(
    (direction === "BUY" ? entryZone.bottom - slBuffer : entryZone.top + slBuffer).toFixed(decimals),
  );
  const risk = Math.abs(entry - stopLoss);
  if (risk < atrVal * 0.35) return null;

  // Tighter targets for scalp: 1.5R / 3R
  const takeProfit = Number(
    (direction === "BUY" ? entry + risk * 1.5 : entry - risk * 1.5).toFixed(decimals),
  );
  const takeProfit2 = Number(
    (direction === "BUY" ? entry + risk * 3 : entry - risk * 3).toFixed(decimals),
  );

  // Confidence: 1H alignment + clean 5M BOS + optional retest OB
  let confidence = 62;
  const confluences: string[] = [
    `✓ ${hStruct.structure} on 1H (${hStruct.trend})`,
    `✓ BOS on 5M (scalp entry)`,
    "Structure 1H · Entry 5M",
  ];
  const breakdown: ConfidenceFactor[] = [
    { label: "1H trend alignment", points: 25, hit: true },
    { label: "5M BOS in trend direction", points: 25, hit: true },
    { label: "5M Order Block retest", points: 15, hit: !!recentOb },
    { label: "Displacement quality", points: 10, hit: mStruct.structure === "BOS" },
  ];
  confidence += recentOb ? 12 : 0;
  confidence = Math.min(92, confidence);

  // Soft filter: don't scalp hard against daily bias if daily is strongly opposite
  // (daily candles not passed here — optional skip)

  return {
    pair,
    direction,
    entry,
    stopLoss,
    takeProfit,
    takeProfit2,
    riskReward: 3,
    confidence,
    structure: "BOS",
    confluences,
    confidenceBreakdown: breakdown,
    currentPrice: Number(currentPrice.toFixed(decimals)),
    timestamp: new Date(last.time * 1000).toISOString(),
    htf_bias: wantTrend,
    ltfConfirmed: true,
    awaitingLtfConfirmation: false,
    autoTrigger: confidence >= 85,
    entryModel,
    entryTrigger: "MARKET_ON_CONFIRMATION",
    entryZone: {
      top: Number(entryZone.top.toFixed(decimals)),
      bottom: Number(entryZone.bottom.toFixed(decimals)),
    },
    signalStyle: "scalp",
    structureTimeframe: "1H",
    entryTimeframe: "5M",
  };
}

// Resolve open trades using two-stage logic + peak R (MFE) accounting:
// 1. If TP1 not yet hit: hit TP1 → mark tp1_hit=true, move SL to break-even (entry).
//    Hit SL first → loss.
// 2. If TP1 already hit: hit TP2 → win at TP2. Hit BE-stop → win.
// 3. Book close uses peak favorable price when it exceeds exit (e.g. +5R then BE → +5R).
async function resolveOpenTrades(
  pair: string,
  candles: Candle[],
): Promise<{ resolved: number }> {
  const { data: open, error } = await db
    .from("trades")
    .select(
      "id, direction, entry, stop_loss, initial_stop_loss, take_profit, take_profit_2, signal_timestamp, tp1_hit, tp1_hit_at, protection_active, protected_stop_loss, protected_at",
    )
    .eq("pair", pair)
    .eq("status", "open");

  if (error || !open?.length) return { resolved: 0 };

  let resolved = 0;
  for (const t of open) {
    const sigTs = new Date(t.signal_timestamp as string).getTime() / 1000;
    const future = candles.filter((c) => c.time > sigTs);
    if (!future.length) continue;

    const isBuy = t.direction === "BUY";
    const entryPrice = Number(t.entry);
    const tp1 = Number(t.take_profit);
    const tp2 = t.take_profit_2 != null ? Number(t.take_profit_2) : tp1; // fallback for legacy rows
    const originalSL = Number(t.initial_stop_loss ?? t.stop_loss);
    if (t.initial_stop_loss == null) {
      await db.from("trades").update({ initial_stop_loss: originalSL }).eq("id", t.id);
    }

    // Walk candles; SL flips to break-even after TP1 hits.
    // Track peak favorable price (MFE). If price reaches e.g. +5R then
    // reverses to BE, the book records +5R — not 0R scratch.
    let tp1Hit = !!t.tp1_hit;
    let tp1HitAt: number | null = t.tp1_hit_at
      ? new Date(t.tp1_hit_at as string).getTime() / 1000
      : null;
    let protectionActive = !!t.protection_active;
    let protectedStop = t.protected_stop_loss != null ? Number(t.protected_stop_loss) : null;
    let outcome: "win" | "loss" | null = null;
    let closePrice: number | null = null;
    let closedAt: number | null = null;
    // Best price seen in the trade direction (for MFE / peak R)
    let peakPrice = entryPrice;

    const oneR = Math.abs(entryPrice - originalSL);
    const rFromPrice = (px: number): number => {
      if (oneR <= 0) return 0;
      return isBuy ? (px - entryPrice) / oneR : (entryPrice - px) / oneR;
    };

    for (const c of future) {
      // Skip candles before TP1 already recorded
      if (tp1HitAt && c.time <= tp1HitAt) continue;

      // Update maximum favorable excursion from this bar's extreme
      if (isBuy) {
        if (c.high > peakPrice) peakPrice = c.high;
      } else {
        if (c.low < peakPrice) peakPrice = c.low;
      }

      const twoRLevel = isBuy ? entryPrice + oneR * 2 : entryPrice - oneR * 2;
      const oneRProtectedStop = isBuy ? entryPrice + oneR : entryPrice - oneR;
      const hitTP1 = !tp1Hit && (isBuy ? c.high >= tp1 : c.low <= tp1);
      const hitTP2 = tp1Hit && (isBuy ? c.high >= tp2 : c.low <= tp2);
      const hitTwoR = !protectionActive && oneR > 0 && (isBuy ? c.high >= twoRLevel : c.low <= twoRLevel);

      // Once +2R is reached, protect +1R before evaluating the rest of this
      // candle. OHLC data cannot reveal intrabar order, so a candle that
      // touches +2R and then the old SL is treated as protected, not a full loss.
      if (hitTwoR) {
        protectionActive = true;
        protectedStop = oneRProtectedStop;
        await db
          .from("trades")
          .update({
            protection_active: true,
            protected_stop_loss: oneRProtectedStop,
            protected_at: new Date(c.time * 1000).toISOString(),
            stop_loss: oneRProtectedStop,
          })
          .eq("id", t.id);
        await sendTradePush(
          `Trade protected · ${pair}`,
          `${t.direction} reached +2R — stop moved to lock +1R at ${oneRProtectedStop}`,
          `${t.id}-protected`,
        );
      }

      const activeSL = protectionActive && protectedStop != null
        ? protectedStop
        : tp1Hit
          ? entryPrice
          : originalSL;
      const hitSL = isBuy ? c.low <= activeSL : c.high >= activeSL;

      // PARTIAL-INVALIDATION EXIT: before TP1, if a 4H candle CLOSES beyond 60%
      // of the risk distance against us, the entry zone has failed. Cut it there
      // (~-0.6R) instead of donating the full stop.
      if (!tp1Hit && !protectionActive && !hitTwoR && !hitSL) {
        const riskDist = Math.abs(entryPrice - originalSL);
        const invalidLevel = isBuy
          ? entryPrice - riskDist * 0.6
          : entryPrice + riskDist * 0.6;
        const closedBeyond = isBuy ? c.close < invalidLevel : c.close > invalidLevel;
        if (riskDist > 0 && closedBeyond) {
          outcome = "loss";
          closePrice = c.close;
          closedAt = c.time;
          break;
        }
      }

      // Worst-case fill: if SL & TP both touched in same candle, SL wins
      if (hitSL && (hitTP1 || hitTP2)) {
        if (tp1Hit || protectionActive) {
          outcome = "win";
          closePrice = activeSL; // may be BE or +1R protect — peak R applied below
        } else {
          outcome = "loss";
          closePrice = originalSL;
        }
        closedAt = c.time;
        break;
      }
      if (hitSL) {
        outcome = (tp1Hit || protectionActive) ? "win" : "loss";
        closePrice = activeSL;
        closedAt = c.time;
        break;
      }
      if (hitTP2) {
        outcome = "win";
        closePrice = tp2;
        closedAt = c.time;
        break;
      }
      if (hitTP1) {
        // Mark TP1 hit, persist, continue toward TP2
        tp1Hit = true;
        tp1HitAt = c.time;
        await db
          .from("trades")
          .update({
            tp1_hit: true,
            tp1_hit_at: new Date(c.time * 1000).toISOString(),
            stop_loss: entryPrice,
          })
          .eq("id", t.id);
      }
    }

    if (outcome) {
      // Book the peak favorable R when it exceeds the exit R.
      // Example: ran to +5R then stopped at BE → close_price = peak, ~+5R not 0R.
      let bookPrice = closePrice;
      if (outcome === "win" && oneR > 0 && bookPrice != null) {
        const exitR = rFromPrice(bookPrice);
        const peakR = rFromPrice(peakPrice);
        if (peakR > exitR + 0.05) {
          bookPrice = peakPrice;
        }
      }

      const bookedR =
        bookPrice != null && oneR > 0 ? Number(rFromPrice(bookPrice).toFixed(2)) : null;

      await db
        .from("trades")
        .update({
          status: outcome,
          close_price: bookPrice,
          closed_at: new Date((closedAt ?? Date.now() / 1000) * 1000).toISOString(),
          // Keep risk_reward aligned with what the book actually credits
          ...(bookedR != null && bookedR > 0 ? { risk_reward: bookedR } : {}),
        })
        .eq("id", t.id);
      await sendTradePush(
        `Trade closed · ${pair} ${outcome === "win" ? "profit" : "loss"}`,
        `${t.direction} closed at ${bookPrice ?? "market"}${
          bookedR != null ? ` · ${bookedR >= 0 ? "+" : ""}${bookedR}R` : ""
        }${closedAt ? ` · ${new Date(closedAt * 1000).toISOString()}` : ""}`,
        `${t.id}-closed-${closedAt ?? Date.now()}`,
      );
      resolved++;
    }
  }
  return { resolved };
}

// Save a freshly detected signal to the trade book (idempotent on pair+timestamp).
async function saveSignalToBook(s: Signal): Promise<void> {
  const { data: existing } = await db
    .from("trades")
    .select("id")
    .eq("pair", s.pair)
    .eq("signal_timestamp", s.timestamp)
    .maybeSingle();
  if (existing) return;

  const { data: openSame } = await db
    .from("trades")
    .select("id")
    .eq("pair", s.pair)
    .eq("status", "open")
    .limit(1);
  if (openSame && openSame.length > 0) return;

  // 24h cooldown after any close — avoid revenge re-entries on the same pair
  const cooldownIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: recentClosed } = await db
    .from("trades")
    .select("id")
    .eq("pair", s.pair)
    .in("status", ["win", "loss"])
    .gte("closed_at", cooldownIso)
    .limit(1);
  if (recentClosed && recentClosed.length > 0) return;

  const { data: inserted, error } = await db.from("trades").insert({
    pair: s.pair,
    direction: s.direction,
    entry: s.entry,
    stop_loss: s.stopLoss,
    take_profit: s.takeProfit,
    take_profit_2: s.takeProfit2,
    risk_reward: s.riskReward,
    confidence: s.confidence,
    structure: s.structure,
    htf_bias: s.htf_bias,
    confluences: s.confluences,
    status: "open",
    signal_timestamp: s.timestamp,
    initial_stop_loss: s.stopLoss,
  }).select("id").single();

  if (error || !inserted) {
    console.error("Could not save trade signal:", error?.message ?? "unknown error");
    return;
  }

  await sendTradePush(
    `Trade entered · ${s.pair} ${s.direction}`,
    `Entry ${s.entry} · SL ${s.stopLoss} · TP1 ${s.takeProfit} · TP2 ${s.takeProfit2} · ${s.confidence}% confidence`,
    inserted.id,
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authorization = req.headers.get("Authorization");
  if (!authorization || !SUPABASE_ANON_KEY) {
    return new Response(JSON.stringify({ error: "Sign in to access trade signals." }), {
      status: authorization ? 500 : 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authorization } },
  });
  const { data: authData, error: authError } = await authClient.auth.getUser();
  if (authError || !authData.user) {
    return new Response(JSON.stringify({ error: "Sign in to access trade signals." }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const results: {
    signals: Signal[];
    developing: DevelopingSetup[];
    scanned: string[];
    errors: { pair: string; error: string }[];
    resolved: number;
  } = {
    signals: [],
    developing: [],
    scanned: [],
    errors: [],
    resolved: 0,
  };

  // Run pairs in parallel — fetch structure TFs + asset-class entry TF
  const settled = await Promise.allSettled(
    PAIRS.map(async ({ pair }) => {
      const entryInterval = entryTimeframeFor(pair);
      // Lower TFs need shorter Yahoo ranges
      const entryRange = entryInterval === "5m" || entryInterval === "15m" ? "1mo" : "3mo";

      const [hourly, daily, entryTf] = await Promise.all([
        fetchYahooCandles(pair, "1h", "3mo"),
        fetchYahooCandles(pair, "1d", "1y"),
        fetchYahooCandles(pair, entryInterval, entryRange as "1mo"),
      ]);
      const fourH = resampleTo4H(hourly);

      const { resolved } = await resolveOpenTrades(pair, hourly);

      // Swing path: 1D + 4H structure, entry TF confirmation
      const { signal, developing } = await analyzePairFromCandles(
        pair,
        fourH,
        daily,
        entryTf.length >= 30 ? entryTf : hourly,
        {
          signalStyle: "swing",
          structureTf: "4H",
          entryTf: entryTfLabel(pair),
        },
      );

      const signals: Signal[] = [];
      if (signal) {
        signals.push(signal);
        await saveSignalToBook(signal);
      }

      // Gold scalp path: 1H trend + 5M BOS (extra signal, does not replace swing)
      if (isGold(pair)) {
        const fiveMin =
          entryInterval === "5m" && entryTf.length >= 40
            ? entryTf
            : await fetchYahooCandles(pair, "5m", "1mo");
        const scalp = await analyzeGoldScalp(pair, hourly, fiveMin);
        if (scalp) {
          signals.push(scalp);
          await saveSignalToBook(scalp);
        }
      }

      return { pair, signals, developing, resolved };
    }),
  );

  for (const r of settled) {
    if (r.status === "fulfilled") {
      results.scanned.push(r.value.pair);
      results.resolved += r.value.resolved;
      for (const s of r.value.signals) results.signals.push(s);
      if (r.value.developing) results.developing.push(r.value.developing);
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      const pairMatch = msg.match(/for ([A-Z0-9]{3,7}(?:\/[A-Z]{3})?)/);
      results.errors.push({ pair: pairMatch?.[1] ?? "unknown", error: msg });
    }
  }

  results.signals.sort((a, b) => b.confidence - a.confidence);
  results.developing.sort((a, b) => b.proximity - a.proximity);

  return new Response(JSON.stringify(results), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
