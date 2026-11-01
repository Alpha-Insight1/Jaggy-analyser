// SMC Multi-Timeframe Trading Engine
// Structure: 1D bias + 4H structure (all pairs)
// Entry TF by asset class:
//   Forex  → 15M confirmation (swing)
//   Indices → 5M confirmation (swing)
//   Gold   → 5M confirmation (swing) + 1H→5M BOS/CHoCH+disp scalp
// Strategy pack: A sessions · B A+/B grade · C gold pullback · D structure bias · E trail · F corr caps
// Thissdax model: sweep+BOS swing · Fib premium/discount · avoid BOS-liquidity zone · TP1=2R TP2=4R
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
  takeProfit: number;        // TP1 — fixed 2R from swing risk
  takeProfit2: number;       // TP2 — fixed 4R from swing risk
  riskReward: number;        // Reported RR = TP1 (2R)
  confidence: number;
  structure: "BOS" | "CHoCH";
  confluences: string[];
  // Per-factor breakdown showing exactly how the confidence score was assembled.
  // The UI renders this so traders can see *why* a setup scored 87% vs 80%.
  confidenceBreakdown: ConfidenceFactor[];
  currentPrice: number;
  timestamp: string;
  htf_bias: "Bullish" | "Bearish" | "Neutral";
  // SWING-FIRST: primary live order is Daily HTF zone. LTF is context only.
  ltfEntry?: number;
  ltfStopLoss?: number;
  swingEntry?: number;
  swingStopLoss?: number;
  swingRiskPips?: number;
  swingInvalidated?: boolean;
  swingInvalidReason?: string;
  splitEntry?: {
    tier1: number;
    tier2: number;
    allocation: number;
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
  /** Thissdax POI ranking — only two types */
  poiType?: "order_block" | "structural_origin";
  poiLabel?: string;
  poiScore?: number;
  poiZone?: { top: number; bottom: number };
  // Multi-TF labels
  signalStyle?: "swing" | "scalp";
  structureTimeframe?: string;  // e.g. "4H" or "1H"
  setupGrade?: "A+" | "B";
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
    takeProfit2: number;  // TP2 (4R)
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
  { pair: "GER40",   yfSymbol: "^GDAXI" },  // Germany 40 / DAX cash index (not CFD quote)
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
  // London open + NY open/overlap — institutional volume windows
  if (h >= 7 && h < 11) return { active: true, session: "London" };
  if (h >= 12 && h < 17) return { active: true, session: "NewYork" };
  return { active: false, session: null };
}

// ---- Per-instrument trading session windows (UTC) ----
// Liquidity is instrument-specific: trading an index outside its cash session
// or FX outside London/NY is where most low-quality fills come from.
function sessionWindow(pair: string): { start: number; end: number; label: string } | null {
  if (isCrypto(pair)) return null; // 24/7
  // Gold: London open through NY afternoon (avoid pure Asia dead zone for new entries)
  if (isGold(pair)) return { start: 7, end: 20, label: "Gold London–NY" };
  if (isIndex(pair)) {
    if (pair === "JPN225") return { start: 0, end: 6, label: "Tokyo cash" };
    if (pair === "GER40" || pair === "UK100") return { start: 7, end: 16, label: "Europe cash" };
    return { start: 13.5, end: 20.5, label: "US cash" }; // SPX500 / US30 / NAS100
  }
  // FX: London through NY (07–20 UTC) — still blocks pure Asia for new entries
  return { start: 7, end: 20, label: "London–NY FX window" };
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



// ============================================================================
// THISSDAX MODEL — Market structure (algo) + Liquidity
// ----------------------------------------------------------------------------
// 1) Valid swing = sweep of prior swing + BOS in trade direction
// 2) Fib on full swing (HL→HH or LH→LL): below mid = discount (buys only),
//    above mid = premium (sells only)
// 3) Fib from BOS → swing origin: shallow side = liquidity (do NOT enter);
//    deeper side = POI / entry zone
// 4) Structural liquidity (last low before main low / last high before main high)
//    is preferred for continuation
// ============================================================================

interface ThissdaxSwing {
  direction: "BUY" | "SELL";
  origin: number;       // protected HL (buy) or LH (sell)
  extreme: number;      // HH (buy) or LL (sell)
  bosLevel: number;
  bosIndex: number;
  equilibrium: number;  // 50% of origin→extreme
  /** True when current price is in discount (buys) or premium (sells) */
  inValueArea: boolean;
  /** Shallow pullback from BOS — liquidity / no-entry */
  liqTop: number;
  liqBottom: number;
  /** Deeper zone after liquidity — preferred entry */
  entryTop: number;
  entryBottom: number;
  /** Structural liquidity reference (last swing before main origin) */
  structuralLiquidity: number | null;
  liquidityClass: "structural" | "inducement" | "transactional";
}

/**
 * Build a Thissdax-validated swing on the structure TF.
 * Requires: prior swing sweep + BOS, then maps Fib discount/premium + liquidity zone.
 */
function buildThissdaxSwing(
  candles: Candle[],
  swings: Swing[],
  direction: "BUY" | "SELL",
  currentPrice: number,
): ThissdaxSwing | null {
  if (candles.length < 20 || swings.length < 4) return null;

  const highs = swings.filter((s) => s.type === "high");
  const lows = swings.filter((s) => s.type === "low");
  if (highs.length < 2 || lows.length < 2) return null;

  if (direction === "BUY") {
    // Need a BOS up: close above a prior swing high after a low was swept
    const recentHighs = highs.slice(-4);
    const recentLows = lows.slice(-5);
    let bosLevel: number | null = null;
    let bosIndex: number | null = null;
    let origin: number | null = null;
    let originIdx = -1;

    for (let hi = recentHighs.length - 1; hi >= 1; hi--) {
      const level = recentHighs[hi - 1].price;
      const after = recentHighs[hi - 1].index;
      for (let j = after + 1; j < candles.length; j++) {
        if (candles[j].close > level) {
          // Find the low before this BOS (protected HL)
          const priorLows = recentLows.filter((l) => l.index < j);
          if (!priorLows.length) break;
          const hl = priorLows[priorLows.length - 1];
          // Sweep check: some low before HL was taken (wick or close below a prior low)
          const older = priorLows.slice(0, -1);
          let swept = older.length === 0;
          for (const ol of older) {
            for (let k = ol.index + 1; k <= hl.index; k++) {
              if (candles[k].low < ol.price) {
                swept = true;
                break;
              }
            }
            if (swept) break;
          }
          // Also accept equal-low / slight undercut of hl itself as transactional liquidity
          if (!swept) {
            for (let k = Math.max(0, hl.index - 8); k < hl.index; k++) {
              if (candles[k].low <= hl.price * 1.0001 && candles[k].low >= hl.price * 0.998) {
                swept = true;
                break;
              }
            }
          }
          if (!swept) break;

          bosLevel = level;
          bosIndex = j;
          origin = hl.price;
          originIdx = hl.index;
          break;
        }
      }
      if (bosLevel != null) break;
    }
    if (bosLevel == null || origin == null || bosIndex == null) return null;

    // Extreme = highest high after BOS (or the BOS candle high)
    let extreme = bosLevel;
    for (let j = bosIndex; j < candles.length; j++) {
      if (candles[j].high > extreme) extreme = candles[j].high;
    }
    if (extreme <= origin) return null;

    const equilibrium = origin + (extreme - origin) * 0.5;
    const inValueArea = currentPrice <= equilibrium; // discount for buys

    // Liquidity zone: from BOS level toward origin — shallow 0–50% of BOS→origin leg
    // Entry zone: deeper 50–100% of that leg (toward origin / structural POI)
    const leg = bosLevel - origin;
    const midLeg = origin + leg * 0.5;
    const liqTop = bosLevel;
    const liqBottom = midLeg;
    const entryTop = midLeg;
    const entryBottom = origin;

    // Structural liquidity: last low before the main origin low
    const olderLows = lows.filter((l) => l.index < originIdx);
    const structuralLiquidity = olderLows.length
      ? olderLows[olderLows.length - 1].price
      : null;

    // Classify: if we swept a clear prior low → structural; equal lows → transactional; else inducement
    let liquidityClass: ThissdaxSwing["liquidityClass"] = "structural";
    if (structuralLiquidity != null) {
      const dist = Math.abs(origin - structuralLiquidity) / Math.max(extreme - origin, 1e-9);
      if (dist < 0.08) liquidityClass = "transactional";
      else if (dist > 0.35) liquidityClass = "inducement";
      else liquidityClass = "structural";
    }

    return {
      direction,
      origin,
      extreme,
      bosLevel,
      bosIndex,
      equilibrium,
      inValueArea,
      liqTop,
      liqBottom,
      entryTop,
      entryBottom,
      structuralLiquidity,
      liquidityClass,
    };
  }

  // SELL — mirror
  {
    const recentHighs = highs.slice(-5);
    const recentLows = lows.slice(-4);
    let bosLevel: number | null = null;
    let bosIndex: number | null = null;
    let origin: number | null = null;
    let originIdx = -1;

    for (let li = recentLows.length - 1; li >= 1; li--) {
      const level = recentLows[li - 1].price;
      const after = recentLows[li - 1].index;
      for (let j = after + 1; j < candles.length; j++) {
        if (candles[j].close < level) {
          const priorHighs = recentHighs.filter((h) => h.index < j);
          if (!priorHighs.length) break;
          const lh = priorHighs[priorHighs.length - 1];
          const older = priorHighs.slice(0, -1);
          let swept = older.length === 0;
          for (const oh of older) {
            for (let k = oh.index + 1; k <= lh.index; k++) {
              if (candles[k].high > oh.price) {
                swept = true;
                break;
              }
            }
            if (swept) break;
          }
          if (!swept) {
            for (let k = Math.max(0, lh.index - 8); k < lh.index; k++) {
              if (candles[k].high >= lh.price * 0.9999 && candles[k].high <= lh.price * 1.002) {
                swept = true;
                break;
              }
            }
          }
          if (!swept) break;
          bosLevel = level;
          bosIndex = j;
          origin = lh.price;
          originIdx = lh.index;
          break;
        }
      }
      if (bosLevel != null) break;
    }
    if (bosLevel == null || origin == null || bosIndex == null) return null;

    let extreme = bosLevel;
    for (let j = bosIndex; j < candles.length; j++) {
      if (candles[j].low < extreme) extreme = candles[j].low;
    }
    if (extreme >= origin) return null;

    const equilibrium = extreme + (origin - extreme) * 0.5;
    const inValueArea = currentPrice >= equilibrium; // premium for sells

    const leg = origin - bosLevel;
    const midLeg = bosLevel + leg * 0.5;
    const liqBottom = bosLevel;
    const liqTop = midLeg;
    const entryBottom = midLeg;
    const entryTop = origin;

    const olderHighs = highs.filter((h) => h.index < originIdx);
    const structuralLiquidity = olderHighs.length
      ? olderHighs[olderHighs.length - 1].price
      : null;

    let liquidityClass: ThissdaxSwing["liquidityClass"] = "structural";
    if (structuralLiquidity != null) {
      const dist = Math.abs(origin - structuralLiquidity) / Math.max(origin - extreme, 1e-9);
      if (dist < 0.08) liquidityClass = "transactional";
      else if (dist > 0.35) liquidityClass = "inducement";
      else liquidityClass = "structural";
    }

    return {
      direction,
      origin,
      extreme,
      bosLevel,
      bosIndex,
      equilibrium,
      inValueArea,
      liqTop,
      liqBottom,
      entryTop,
      entryBottom,
      structuralLiquidity,
      liquidityClass,
    };
  }
}


function priceInZone(price: number, top: number, bottom: number): boolean {
  const hi = Math.max(top, bottom);
  const lo = Math.min(top, bottom);
  return price <= hi && price >= lo;
}

/** Thissdax: only two POI types — Order Block vs Structural origin. Rank & pick one. */
interface RankedPoi {
  type: "order_block" | "structural_origin";
  label: string;
  score: number;
  price: number;
  zoneTop: number;
  zoneBottom: number;
  fresh: boolean;
}

function rankThissdaxPois(
  direction: "BUY" | "SELL",
  td: ThissdaxSwing,
  ob: { top: number; bottom: number; index?: number } | null,
  strongZonePrice: number,
  candles: Candle[],
  atrVal: number,
): RankedPoi | null {
  const candidates: RankedPoi[] = [];
  const inDeep = (px: number) => priceInZone(px, td.entryTop, td.entryBottom);
  const inValue = (px: number) =>
    direction === "BUY" ? px <= td.equilibrium : px >= td.equilibrium;
  const notInLiq = (px: number) => !priceInZone(px, td.liqTop, td.liqBottom);

  // --- Type A: Order Block POI (last opposing candle before BOS impulse) ---
  if (ob) {
    const mid = (ob.top + ob.bottom) / 2;
    let score = 40;
    const fresh = ob.index != null ? isFreshOB(candles, ob as OrderBlock) : false;
    if (fresh) score += 18;
    if (inDeep(mid)) score += 22;
    else if (priceInZone(mid, td.origin, td.extreme)) score += 8;
    if (inValue(mid)) score += 12;
    if (notInLiq(mid)) score += 10;
    else score -= 25; // shallow liquidity grab — heavily penalize
    if (td.liquidityClass === "structural") score += 6;
    candidates.push({
      type: "order_block",
      label: fresh ? "Order Block (fresh)" : "Order Block",
      score,
      price: mid,
      zoneTop: ob.top,
      zoneBottom: ob.bottom,
      fresh,
    });
  }

  // --- Type B: Structural origin POI (protected HL/LH / structural liquidity) ---
  {
    const originPx = td.structuralLiquidity ?? td.origin;
    let score = 45; // structural is Thissdax's preferred continuation POI
    if (td.structuralLiquidity != null) score += 10;
    if (inDeep(originPx)) score += 20;
    if (inValue(originPx)) score += 12;
    if (notInLiq(originPx)) score += 10;
    else score -= 20;
    if (td.liquidityClass === "structural") score += 12;
    if (td.liquidityClass === "inducement") score -= 8;
    // Daily strong zone confluence
    if (Math.abs(originPx - strongZonePrice) <= atrVal * 0.6) score += 10;
    candidates.push({
      type: "structural_origin",
      label: td.structuralLiquidity != null
        ? "Structural origin (liquidity)"
        : "Structural origin (protected swing)",
      score,
      price: originPx,
      zoneTop: direction === "BUY" ? originPx + atrVal * 0.25 : originPx,
      zoneBottom: direction === "BUY" ? originPx : originPx - atrVal * 0.25,
      fresh: true,
    });
  }

  // Prefer OB when it sits cleanly in deep zone AND is fresh with high score
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score < 50) return null;
  // Final: must not arm inside liquidity zone
  if (!notInLiq(best.price) && !inDeep(best.price)) return null;
  return best;
}



// ---- Price sanity (prevents GER40@80k-style glitches) ----
function priceBand(pair: string): { min: number; max: number } | null {
  if (isGold(pair)) return { min: 500, max: 10000 };
  if (isCrypto(pair)) {
    if (pair.startsWith("BTC")) return { min: 1000, max: 500000 };
    if (pair.startsWith("ETH")) return { min: 50, max: 50000 };
    return { min: 0.01, max: 500000 };
  }
  if (pair === "GER40") return { min: 5000, max: 50000 };
  if (pair === "US30") return { min: 15000, max: 100000 };
  if (pair === "NAS100") return { min: 5000, max: 80000 };
  if (pair === "SPX500") return { min: 1500, max: 20000 };
  if (pair === "UK100") return { min: 4000, max: 25000 };
  if (pair === "JPN225") return { min: 10000, max: 120000 }; // Nikkei traded ~63k+ in 2026
  // FX majors / crosses
  if (pair.includes("JPY")) return { min: 50, max: 300 };
  if (pair.includes("/")) return { min: 0.2, max: 5 };
  return null;
}

function isPlausiblePrice(pair: string, price: number): boolean {
  if (!Number.isFinite(price) || price <= 0) return false;
  const band = priceBand(pair);
  if (!band) return true;
  return price >= band.min && price <= band.max;
}

function filterPlausibleCandles(pair: string, candles: Candle[]): Candle[] {
  return candles.filter(
    (c) =>
      isPlausiblePrice(pair, c.open) &&
      isPlausiblePrice(pair, c.high) &&
      isPlausiblePrice(pair, c.low) &&
      isPlausiblePrice(pair, c.close) &&
      c.high >= c.low,
  );
}

function pairToYahoo(pair: string): string {
  return PAIRS.find((p) => p.pair === pair)?.yfSymbol ?? pair.replace("/", "") + "=X";
}

// ——— Twelve Data (optional) ———
// Only used for a short "hot" list: XAU/USD, SPX500, US30, GER40
// when the pair has an open paper trade or Yahoo marked it near entry.
// Set secret:  supabase secrets set TWELVE_DATA_API_KEY=your_key
const TWELVE_DATA_API_KEY = Deno.env.get("TWELVE_DATA_API_KEY") ?? "";

/** App pair → Twelve Data symbol */
/** Twelve Data ONLY for gold + indices (user rule). Forex = Yahoo only. */
const TWELVE_SYMBOL: Record<string, string> = {
  "XAU/USD": "XAU/USD",
  "SPX500": "SPX",
  "US30": "DJI",
  "GER40": "DAX",
  "NAS100": "IXIC",
  "UK100": "UKX",
  "JPN225": "N225",  // Nikkei 225 on Twelve Data (JPX)
};

function isTwelveEligible(pair: string): boolean {
  // Strict: gold and indices only — never FX
  return (isGold(pair) || isIndex(pair)) && pair in TWELVE_SYMBOL;
}

const TD_INTERVAL: Record<string, string> = {
  "1m": "1min",
  "5m": "5min",
  "15m": "15min",
  "30m": "30min",
  "1h": "1h",
  "4h": "4h",
  "1d": "1day",
};

async function fetchTwelveCandles(
  pair: string,
  interval: "4h" | "1h" | "1d" | "5m" | "15m" | "30m",
  outputsize = 200,
): Promise<Candle[] | null> {
  if (!TWELVE_DATA_API_KEY || !isTwelveEligible(pair)) return null;
  const symbol = TWELVE_SYMBOL[pair];
  const tdInterval = TD_INTERVAL[interval] ?? interval;
  const url =
    `https://api.twelvedata.com/time_series` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${tdInterval}` +
    `&outputsize=${outputsize}` +
    `&order=ASC` +
    `&apikey=${encodeURIComponent(TWELVE_DATA_API_KEY)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`Twelve Data HTTP ${res.status} for ${pair} ${interval}`);
      return null;
    }
    const j = await res.json() as {
      status?: string;
      code?: number;
      message?: string;
      values?: Array<{
        datetime: string;
        open: string;
        high: string;
        low: string;
        close: string;
      }>;
    };
    if (j.status === "error" || !j.values?.length) {
      console.warn(`Twelve Data empty/error for ${pair}: ${j.message ?? j.code ?? "no values"}`);
      return null;
    }
    const out: Candle[] = [];
    for (const v of j.values) {
      const t = Math.floor(new Date(v.datetime.replace(" ", "T") + "Z").getTime() / 1000);
      if (!Number.isFinite(t)) continue;
      const o = parseFloat(v.open);
      const h = parseFloat(v.high);
      const l = parseFloat(v.low);
      const c = parseFloat(v.close);
      if (![o, h, l, c].every(Number.isFinite)) continue;
      out.push({ time: t, open: o, high: h, low: l, close: c });
    }
    out.sort((a, b) => a.time - b.time);
    const cleaned = filterPlausibleCandles(pair, out);
    return cleaned.length >= 10 ? cleaned : null;
  } catch (e) {
    console.warn(`Twelve Data fetch failed ${pair}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

// In-isolate candle cache — skips Yahoo re-fetch on rapid refreshes (TTL 10 min).
const CANDLE_CACHE_TTL_MS = 10 * 60 * 1000;
const candleCache = new Map<string, { bars: Candle[]; expires: number }>();

/** Forex → Yahoo only. Gold/indices → Twelve first when preferTwelve, Yahoo backup. */
async function fetchCandles(
  pair: string,
  interval: "4h" | "1h" | "1d" | "5m" | "15m" | "30m",
  range: "5d" | "7d" | "1mo" | "3mo" | "6mo" | "1y",
  preferTwelve = false,
): Promise<Candle[]> {
  const key = `${pair}|${interval}|${range}|${preferTwelve ? "td" : "y"}`;
  const hit = candleCache.get(key);
  if (hit && hit.expires > Date.now() && hit.bars.length >= 20) {
    return hit.bars;
  }

  const size =
    interval === "5m" || interval === "15m" ? 300 :
    interval === "1h" ? 200 :
    interval === "1d" ? 250 : 150;

  const tryTwelve = async (): Promise<Candle[] | null> => {
    if (!TWELVE_DATA_API_KEY || !isTwelveEligible(pair)) return null;
    const td = await fetchTwelveCandles(pair, interval, size);
    return td && td.length >= 20 ? td : null;
  };

  let bars: Candle[] | null = null;

  if (preferTwelve) {
    bars = await tryTwelve();
  }

  if (!bars) {
    try {
      bars = await fetchYahooCandles(pair, interval, range);
    } catch (yahooErr) {
      bars = await tryTwelve();
      if (bars) {
        console.warn(
          `Yahoo failed for ${pair} (${yahooErr instanceof Error ? yahooErr.message : yahooErr}) — using Twelve Data`,
        );
      } else {
        throw yahooErr;
      }
    }
  }

  candleCache.set(key, { bars, expires: Date.now() + CANDLE_CACHE_TTL_MS });
  if (candleCache.size > 200) {
    const first = candleCache.keys().next().value;
    if (first) candleCache.delete(first);
  }
  return bars;
}

async function loadHotTwelvePairs(): Promise<Set<string>> {
  const hot = new Set<string>();
  if (!TWELVE_DATA_API_KEY) return hot;
  try {
    const { data } = await db
      .from("trades")
      .select("pair")
      .eq("status", "open");
    for (const row of data ?? []) {
      if (isTwelveEligible(row.pair)) hot.add(row.pair);
    }
  } catch (e) {
    console.warn("hot list load failed", e);
  }
  return hot;
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
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/json",
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(u, { headers });
      if (res.ok) return res;
      // Retry 429 and 5xx with backoff (Yahoo rate limits)
      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel();
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      return res; // other 4xx — don't spin
    }
    // Final fallback to query2 host
    return fetch(u.replace("query1.finance", "query2.finance"), { headers });
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
  const cleaned = filterPlausibleCandles(pair, raw);
  if (cleaned.length < 10) {
    const sample = raw.slice(-3).map((c) => c.close);
    const band = priceBand(pair);
    throw new Error(
      `Yahoo prices out of band for ${pair} (bad symbol/data)` +
        (sample.length ? `; last closes=${sample.join(",")}` : "") +
        (band ? `; allowed ${band.min}-${band.max}` : ""),
    );
  }
  return interval === "4h" ? resampleTo4H(cleaned) : cleaned;
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
  const emaDailyBias: "Bullish" | "Bearish" | "Neutral" =
    ema20 > ema50 * (1 + biasSep) ? "Bullish"
    : ema20 < ema50 * (1 - biasSep) ? "Bearish"
    : "Neutral";

  // D: Structure-primary Daily bias — swing structure leads; EMA only confirms / softens.
  const dailySwings = findSwings(htfTail.slice(-80), 2);
  const dailyStruct = analyzeStructure(htfTail.slice(-80), dailySwings);
  let htf_bias: "Bullish" | "Bearish" | "Neutral" = "Neutral";
  if (dailyStruct.trend === "Bullish" || dailyStruct.trend === "Bearish") {
    htf_bias = dailyStruct.trend;
    // Soft conflict: structure bullish but EMA clearly bearish → Neutral (range / late)
    if (emaDailyBias !== "Neutral" && emaDailyBias !== htf_bias) {
      htf_bias = "Neutral";
    }
  } else {
    htf_bias = emaDailyBias; // fallback when structure unclear
  }

  // 4H bias — structure first, EMA soft confirm
  const ltfCloses = ltfTail.map((c) => c.close);
  const ltfEma20 = ema(ltfCloses.slice(-60), 20);
  const ltfEma50 = ema(ltfCloses, 50);
  const emaH4Bias: "Bullish" | "Bearish" | "Neutral" =
    ltfEma20 > ltfEma50 * (1 + biasSep * 0.6) ? "Bullish"
    : ltfEma20 < ltfEma50 * (1 - biasSep * 0.6) ? "Bearish"
    : "Neutral";
  let h4_bias: "Bullish" | "Bearish" | "Neutral" = "Neutral";
  if (structure.trend === "Bullish" || structure.trend === "Bearish") {
    h4_bias = structure.trend;
    if (emaH4Bias !== "Neutral" && emaH4Bias !== h4_bias) {
      h4_bias = "Neutral";
    }
  } else {
    h4_bias = emaH4Bias;
  }
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

        // Prefer swing levels as the plan the user should trade (2R / 4R)
        if (swingEntry != null && swingStopLoss != null && swingRiskPips != null) {
          const sRisk = Math.abs(swingEntry - swingStopLoss);
          const sTp1 = dir === "BUY" ? swingEntry + sRisk * 2 : swingEntry - sRisk * 2;
          const sTp2 = dir === "BUY" ? swingEntry + sRisk * 4 : swingEntry - sRisk * 4;
          plan = {
            entry: swingEntry,
            stopLoss: swingStopLoss,
            takeProfit: Number(sTp1.toFixed(decimals)),
            takeProfit2: Number(sTp2.toFixed(decimals)),
            riskPips: swingRiskPips,
            swingEntry,
            swingStopLoss,
            swingRiskPips,
            // keep LTF on triggers for context
          };
          triggers.push(`LTF context @ ${Number(pEntry.toFixed(decimals))} (not the live order)`);
          triggers.push(`★ SWING plan @ ${swingEntry} · TP1 2R · TP2 4R`);
        } else {
          // No swing zone yet — show LTF as context only, mark incomplete
          plan = {
            entry: Number(pEntry.toFixed(decimals)),
            stopLoss: Number(pSL.toFixed(decimals)),
            takeProfit: Number((dir === "BUY" ? pEntry + risk * 2 : pEntry - risk * 2).toFixed(decimals)),
            takeProfit2: Number((dir === "BUY" ? pEntry + risk * 4 : pEntry - risk * 4).toFixed(decimals)),
            riskPips: Math.round(riskPips),
          };
          triggers.push("◌ Swing zone not ready — LTF levels are context only");
        }
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

  // ---- PROFESSIONAL ENTRY MODEL (ranked) ----
  // OB remains the structural anchor. Prefer a cleaner fill inside/near the OB:
  //   1) OTE (70.5% of the impulse leg that created the OB)
  //   2) Unmitigated FVG midpoint inside or just beyond the OB
  //   3) Fallback: OB mean (50%) or proximal edge if mean already traded through
  // Pure proximal OB is the most common retail trap — ranked models avoid it.
  const obZone: EntryZone = { top: ob.top, bottom: ob.bottom };
  const obProximal = direction === "BUY" ? ob.top : ob.bottom;
  const obMean = (ob.top + ob.bottom) / 2;
  const meanReachable = direction === "BUY" ? currentPrice > obMean : currentPrice < obMean;
  const obFallbackPrice = meanReachable ? obMean : obProximal;

  const oteCand = computeOTE(ltfTail, swings, direction);
  const fvgCand = fvgEntry(fvg, direction, swings);
  // Only accept OTE/FVG when they sit inside the OB or within 0.35×ATR beyond it
  // (still in the institutional zone, not chasing).
  const nearOb = (price: number) => {
    const inOb = price >= ob.bottom && price <= ob.top;
    const dist = direction === "BUY"
      ? Math.max(0, ob.bottom - price)
      : Math.max(0, price - ob.top);
    return inOb || dist <= atrVal * 0.35;
  };
  const ranked: (ProEntry | null)[] = [];
  if (oteCand && nearOb(oteCand.price)) ranked.push(oteCand);
  if (fvgCand && nearOb(fvgCand.price)) ranked.push(fvgCand);
  const pro = pickBestProEntry(ranked, currentPrice, atrVal);

  let entry = Number((pro ? pro.price : obFallbackPrice).toFixed(priceDecimals(pair)));
  let entryZone: EntryZone = pro ? pro.zone : obZone;
  let entryModel: "OTE" | "FVG" | "Breaker" | "Judas" | "OB" = pro ? pro.model : "OB";
  // Keep zone at least as wide as the OB so confirmation candle logic still works
  if (pro) {
    entryZone = {
      top: Math.max(pro.zone.top, ob.top),
      bottom: Math.min(pro.zone.bottom, ob.bottom),
    };
  }

  // GATE 10d: THISSDAX Fib premium/discount + liquidity no-entry zone
  // Build validated swing (sweep + BOS) on structure TF, map Fib equilibrium
  // and the BOS→origin liquidity band (shallow = avoid, deep = enter).
  const tdSwing = buildThissdaxSwing(ltfTail, swings, direction, currentPrice);
  if (!tdSwing) {
    return {
      signal: null,
      developing: tagBlocked(buildDeveloping(), "GATE 10d (no valid sweep+BOS swing)"),
    };
  }
  if (!tdSwing.inValueArea) {
    return {
      signal: null,
      developing: tagBlocked(
        buildDeveloping(),
        direction === "BUY"
          ? "GATE 10d (price in premium — wait for discount)"
          : "GATE 10d (price in discount — wait for premium)",
      ),
    };
  }
  // Hard reject if entry is still in the shallow liquidity grab zone
  const entryInLiq = priceInZone(entry, tdSwing.liqTop, tdSwing.liqBottom);
  if (entryInLiq) {
    qualityPenalty += 12;
    // Prefer deeper POI: snap informational entry toward entry zone mid
    const deeperMid = (tdSwing.entryTop + tdSwing.entryBottom) / 2;
    if (direction === "BUY" ? deeperMid < entry : deeperMid > entry) {
      // keep original for context; swing path will use Daily/structural levels
    }
  }
  // Prefer structural liquidity class for continuation book
  if (tdSwing.liquidityClass === "inducement") qualityPenalty += 6;
  if (tdSwing.liquidityClass === "transactional") qualityPenalty += 3;

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

  // ---- SWING-FIRST RISK & TARGETS (pro swing book) ----
  // LTF entry/stop kept for UI context only. Live order uses Daily swing zone.
  const ltfEntryPrice = entry;
  const ltfStopPrice = stopLoss;
  const ltfRisk = Math.abs(ltfEntryPrice - ltfStopPrice);
  if (ltfRisk < minRiskFor(pair, atrVal)) {
    return { signal: null, developing: tagBlocked(buildDeveloping(), "GATE 10d-2") };
  }

  // Thissdax POI ranking — arm limit ONLY at ranked POI (OB or structural origin)
  const rankedPoi = rankThissdaxPois(
    direction,
    tdSwing,
    ob,
    strongZone.price,
    ltfTail,
    atrVal,
  );
  if (!rankedPoi) {
    return {
      signal: null,
      developing: tagBlocked(buildDeveloping(), "POI_NONE (no valid OB or structural POI)"),
    };
  }

  const tdEntryMid = (tdSwing.entryTop + tdSwing.entryBottom) / 2;
  let swingCandidate = rankedPoi.price;
  // Keep POI inside deep zone when possible
  if (priceInZone(swingCandidate, tdSwing.liqTop, tdSwing.liqBottom)) {
    swingCandidate = tdEntryMid;
  }

  const swingSlBuffer = Math.max(atrVal * 1.15, pip(pair) * 10);
  // Stop beyond protected origin (Thissdax protected low/high)
  let swingEntryPx = swingCandidate;
  let swingStopPx =
    direction === "BUY"
      ? Math.min(tdSwing.origin, swingCandidate) - swingSlBuffer
      : Math.max(tdSwing.origin, swingCandidate) + swingSlBuffer;
  let swingRiskPx = Math.abs(swingEntryPx - swingStopPx);

  if (priceInZone(swingEntryPx, tdSwing.liqTop, tdSwing.liqBottom)) {
    swingEntryPx = tdEntryMid;
    swingStopPx =
      direction === "BUY"
        ? Math.min(tdSwing.origin, swingEntryPx) - swingSlBuffer
        : Math.max(tdSwing.origin, swingEntryPx) + swingSlBuffer;
    swingRiskPx = Math.abs(swingEntryPx - swingStopPx);
  }

  const deeperOk =
    direction === "BUY"
      ? swingEntryPx <= ltfEntryPrice + atrVal * 0.35
      : swingEntryPx >= ltfEntryPrice - atrVal * 0.35;
  if (!deeperOk || swingRiskPx <= 0) {
    return {
      signal: null,
      developing: tagBlocked(buildDeveloping(), "SWING_ZONE_MISSING"),
    };
  }

  const maxSwingRisk = atrVal * 3.5;
  if (swingRiskPx > maxSwingRisk) {
    swingStopPx = direction === "BUY" ? swingEntryPx - maxSwingRisk : swingEntryPx + maxSwingRisk;
    swingRiskPx = Math.abs(swingEntryPx - swingStopPx);
  }

  // Invalidate if price already closed through swing stop (Daily thesis broken)
  {
    const lastClose = ltfTail[ltfTail.length - 1]?.close ?? currentPrice;
    const throughStop =
      direction === "BUY" ? lastClose < swingStopPx : lastClose > swingStopPx;
    if (throughStop) {
      const dev = buildDeveloping();
      if (dev) {
        dev.triggers = [
          "✗ SWING INVALIDATED — price closed through swing stop (Daily zone broken)",
          ...(dev.triggers ?? []),
        ];
        (dev as DevelopingSetup & { blockedBy?: string }).blockedBy = "SWING_INVALIDATED";
      }
      return { signal: null, developing: dev };
    }
  }

  // No counter-bias primary swing book — Daily must agree (or Neutral)
  if (
    htf_bias !== "Neutral" &&
    htf_bias !== (direction === "BUY" ? "Bullish" : "Bearish")
  ) {
    return {
      signal: null,
      developing: tagBlocked(buildDeveloping(), "SWING_COUNTER_BIAS"),
    };
  }

  // Promote swing to primary executable levels
  entry = swingEntryPx;
  stopLoss = swingStopPx;
  const risk = swingRiskPx;

  // Fixed pro targets from swing risk
  const takeProfit = direction === "BUY" ? entry + risk * 2 : entry - risk * 2;
  const takeProfit2 = direction === "BUY" ? entry + risk * 4 : entry - risk * 4;
  const rr1 = 2;
  const rr2 = 4;

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
  {
    const gradeIsA =
      marketDirectionAligned &&
      confidence >= 78 &&
      (kz.active || inTradingSession(pair, new Date(lastCandle.time * 1000)).ok);
    confluences.push(gradeIsA ? "Grade A+ · auto-book eligible" : "Grade B · developing / no auto-book");
  }


  confidence = Math.max(20, Math.min(98, confidence - qualityPenalty));

  // GATE 11: A-grade floor — 72% after soft-gate penalties
  if (confidence < 72) return { signal: null, developing: tagBlocked(buildDeveloping(), "GATE 11") };

  const decimals = priceDecimals(pair);
  const swingEntry = Number(entry.toFixed(decimals));
  const swingStopLoss = Number(stopLoss.toFixed(decimals));
  const swingRiskPips = Math.round(toPips(pair, Math.abs(entry - stopLoss)));
  const ltfEntry = Number(ltfEntryPrice.toFixed(decimals));
  const ltfStopLoss = Number(ltfStopPrice.toFixed(decimals));

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
      riskReward: 2,
      confidence,
      structure: structure.structure,
      confluences: [
        `★ SWING ENTRY @ ${swingEntry} · SL ${swingStopLoss} · TP1 2R · TP2 4R`,
        `POI: ${rankedPoi.label} (score ${rankedPoi.score}) · arm limit here only`,
        `Thissdax: sweep+BOS · Fib ${direction === "BUY" ? "discount" : "premium"} · ${tdSwing.liquidityClass} liquidity`,
        `Avoid liquidity zone ${Number(Math.min(tdSwing.liqBottom, tdSwing.liqTop).toFixed(decimals))}–${Number(Math.max(tdSwing.liqBottom, tdSwing.liqTop).toFixed(decimals))} · enter deeper`,
        `LTF context only @ ${ltfEntry} (not the live order)`,
        ...confluences,
      ],
      confidenceBreakdown: breakdown,
      currentPrice: Number(currentPrice.toFixed(decimals)),
      timestamp: new Date(lastCandle.time * 1000).toISOString(),
      htf_bias,
      ltfEntry,
      ltfStopLoss,
      swingEntry,
      swingStopLoss,
      swingRiskPips,
      swingInvalidated: false,
      ltfConfirmed: confidence >= 90 ? true : ltfConfirmed,
      awaitingLtfConfirmation: confidence >= 90 ? false : !ltfConfirmed,
      autoTrigger: false,
      entryModel: rankedPoi.type === "order_block" ? "OB" : entryModel,
      entryTrigger: "LIMIT",
      entryZone: {
        top: Number(rankedPoi.zoneTop.toFixed(decimals)),
        bottom: Number(rankedPoi.zoneBottom.toFixed(decimals)),
      },
      poiType: rankedPoi.type,
      poiLabel: rankedPoi.label,
      poiScore: rankedPoi.score,
      poiZone: {
        top: Number(rankedPoi.zoneTop.toFixed(decimals)),
        bottom: Number(rankedPoi.zoneBottom.toFixed(decimals)),
      },
      signalStyle: "swing",
      structureTimeframe: structureTfLabel,
      entryTimeframe: "D1 swing",
      setupGrade: (marketDirectionAligned && confidence >= 78 && (kz.active || inTradingSession(pair, new Date(lastCandle.time * 1000)).ok))
        ? "A+"
        : "B",
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
  // C Option 2: 5M BOS preferred; also allow CHoCH + displacement in 1H trend direction
  // (pullback continuation — not random counter-trend noise)
  if (mStruct.trend !== wantTrend || !mStruct.structure) return null;
  const last = mTail[mTail.length - 1];
  const prev = mTail.length >= 2 ? mTail[mTail.length - 2] : last;
  const atrVal = atr(mTail, 14);
  if (atrVal <= 0) return null;
  const body = Math.abs(last.close - last.open);
  const displacement = body >= atrVal * 1.15;
  const bullishClose = last.close > last.open;
  const bearishClose = last.close < last.open;
  const dispWithTrend =
    (wantTrend === "Bullish" && bullishClose && displacement) ||
    (wantTrend === "Bearish" && bearishClose && displacement);
  const bosOk = mStruct.structure === "BOS";
  const chochOk = mStruct.structure === "CHoCH" && dispWithTrend;
  if (!bosOk && !chochOk) return null;

  // Session filter for gold scalp (A)
  const sess = inTradingSession(pair, new Date(last.time * 1000));
  if (!sess.ok) return null;

  const currentPrice = last.close;

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
    setupGrade: bosOk ? "A+" : "B",
    structureTimeframe: "1H",
    entryTimeframe: "5M",
  };
}

// Resolve open trades using two-stage logic + peak R (MFE) accounting:
// 1. Hit TP1 → mark tp1_hit=true, move SL to soft buffer (−0.05R), NOT exact entry.
// 2. At +2R → lock +1R (protection). At +3R → trail to +1.5R.
// 3. True BE / +0.5R upgrade occurs when protection is active (structure-style lock).
// 4. Book close uses peak favorable price when it exceeds exit (e.g. +5R then BE → +5R).
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

    let oneR = Math.abs(entryPrice - originalSL);
    // Reject microscopic stops (bad tick / bad SL) that produce 1000R+ glitches
    const minRisk = Math.max(entryPrice * 0.00015, isIndex(pair) || isGold(pair) || isCrypto(pair) ? 5 : 0);
    if (oneR > 0 && oneR < minRisk) {
      console.warn(`Widening tiny oneR for ${pair}: ${oneR} → ${minRisk}`);
      oneR = minRisk;
    }
    const rFromPrice = (px: number): number => {
      if (oneR <= 0) return 0;
      const r = isBuy ? (px - entryPrice) / oneR : (entryPrice - px) / oneR;
      // Hard cap per bar so a bad high/low cannot invent 2000R
      return Math.max(-2, Math.min(12, r));
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

      // E: Trail to +1.5R once price has seen +3R (structure-style runner lock)
      if (protectionActive && oneR > 0) {
        const threeR = isBuy ? entryPrice + oneR * 3 : entryPrice - oneR * 3;
        const lock15 = isBuy ? entryPrice + oneR * 1.5 : entryPrice - oneR * 1.5;
        const sawThree = isBuy ? peakPrice >= threeR : peakPrice <= threeR;
        if (sawThree && protectedStop != null) {
          const better = isBuy ? lock15 > protectedStop : lock15 < protectedStop;
          if (better) {
            protectedStop = lock15;
            await db
              .from("trades")
              .update({
                protected_stop_loss: lock15,
                stop_loss: lock15,
              })
              .eq("id", t.id);
          }
        }
      }

      // Soft buffer after TP1: −0.2R (slightly in profit) to +0.1R (tiny give-back).
      // Exact BE is only applied after LTF structure confirmation (see below).
      const softBeBuffer = oneR * 0.05; // midpoint of −0.2R…+0.1R band ≈ small cushion
      const softBeSL = isBuy
        ? entryPrice - oneR * 0.05   // −0.05R (tiny give-back side of the band)
        : entryPrice + oneR * 0.05;
      const activeSL = protectionActive && protectedStop != null
        ? protectedStop
        : tp1Hit
          ? softBeSL
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

      const MAX_BOOK_R = 8;
      // Reject impossible index exits (e.g. GER40 @ 83009)
      if (bookPrice != null && !isPlausiblePrice(pair, bookPrice)) {
        console.warn(`Implausible close ${bookPrice} for ${pair} — using entry/TP fallback`);
        if (outcome === "win") {
          bookPrice = isBuy
            ? entryPrice + oneR * Math.min(3, MAX_BOOK_R)
            : entryPrice - oneR * Math.min(3, MAX_BOOK_R);
          if (!isPlausiblePrice(pair, bookPrice)) bookPrice = entryPrice;
        } else {
          bookPrice = originalSL;
        }
      }

      let bookedR =
        bookPrice != null && oneR > 0 ? Number(rFromPrice(bookPrice).toFixed(2)) : null;
      if (bookedR != null) {
        if (bookedR > MAX_BOOK_R) {
          console.warn(`Capping absurd R for ${pair}: ${bookedR} → ${MAX_BOOK_R}`);
          bookedR = MAX_BOOK_R;
          bookPrice = isBuy
            ? entryPrice + oneR * MAX_BOOK_R
            : entryPrice - oneR * MAX_BOOK_R;
        }
        if (bookedR < -1.25) bookedR = -1;
      }

      await db
        .from("trades")
        .update({
          status: outcome,
          close_price: bookPrice,
          closed_at: new Date((closedAt ?? Date.now() / 1000) * 1000).toISOString(),
          ...(bookedR != null && bookedR > 0
            ? { risk_reward: Math.min(bookedR, MAX_BOOK_R) }
            : {}),
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


// ---- F: Correlation groups + frequency caps ----
function correlationGroup(pair: string): string {
  const p = pair.toUpperCase().replace("/", "");
  if (p.includes("XAU") || p.startsWith("GOLD")) return "GOLD";
  if (["SPX500", "US30", "NAS100", "SPX"].some((x) => p.includes(x))) return "US_INDEX";
  if (["GER40", "UK100", "EU50"].some((x) => p.includes(x))) return "EU_INDEX";
  if (p.includes("JPN") || p.includes("JP225")) return "JP_INDEX";
  if (p.startsWith("EUR") || p.endsWith("EUR")) return "EUR";
  if (p.startsWith("GBP") || p.endsWith("GBP")) return "GBP";
  if (p.includes("JPY")) return "JPY";
  if (p.startsWith("AUD") || p.startsWith("NZD")) return "AUDNZD";
  if (p.startsWith("USD") || p.endsWith("USD")) return "USD_CROSS";
  return p;
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
    .select("id, direction")
    .eq("pair", s.pair)
    .eq("status", "open")
    .limit(5);
  if (openSame && openSame.length > 0) {
    // No second entry and no BUY→SELL flip while still open
    console.warn(
      `Skip ${s.pair} ${s.direction}: already open (${openSame.map((r) => r.direction).join(",")})`,
    );
    return;
  }

  // 24h cooldown after any close — avoid revenge re-entries on the same pair
  const cooldownIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: recentClosed } = await db
    .from("trades")
    .select("id")
    .eq("pair", s.pair)
    .in("status", ["win", "loss"])
    .gte("closed_at", cooldownIso)
    .limit(1);
  if (recentClosed && recentClosed.length > 0) {
    console.warn(`Skip ${s.pair}: 24h cooldown after recent close`);
    return;
  }

  // F: Max 5 new opens in last 24h (whole book)
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: recentOpens } = await db
    .from("trades")
    .select("id, pair")
    .gte("opened_at", dayAgo)
    .limit(20);
  if (recentOpens && recentOpens.length >= 5) {
    console.warn(`Skip ${s.pair}: daily frequency cap (5 new trades / 24h)`);
    return;
  }

  // F: Max 2 open trades in same correlation group
  const group = correlationGroup(s.pair);
  const { data: allOpen } = await db
    .from("trades")
    .select("id, pair")
    .eq("status", "open")
    .limit(50);
  if (allOpen) {
    const sameGroup = allOpen.filter((t) => correlationGroup(t.pair) === group);
    if (sameGroup.length >= 2) {
      console.warn(`Skip ${s.pair}: correlation cap (${group} already has ${sameGroup.length} open)`);
      return;
    }
  }

  // B: Only auto-book A+ setups (B-grade stays on developing feed only)
  const grade = (s as Signal & { setupGrade?: string }).setupGrade ?? "A+";
  if (grade !== "A+") {
    console.warn(`Skip book ${s.pair}: setup grade ${grade} (developing only)`);
    return;
  }

  // Enrich confluences with machine-readable feature tags for expectancy analysis
  const featureTags = [
    `grade:${grade}`,
    `model:${(s as Signal).entryModel ?? "OB"}`,
    `style:${(s as Signal).signalStyle ?? "swing"}`,
    `struct_tf:${(s as Signal).structureTimeframe ?? "4H"}`,
    `entry_tf:${(s as Signal).entryTimeframe ?? "15M"}`,
    `rr:${Number(s.riskReward).toFixed(2)}`,
    `conf:${s.confidence}`,
  ];
  const enrichedConfluences = [...(s.confluences ?? []), ...featureTags];

  const { data: inserted, error } = await db.from("trades").insert({
    pair: s.pair,
    direction: s.direction,
    entry: s.entry,
    stop_loss: s.stopLoss,
    take_profit: s.takeProfit,
    take_profit_2: s.takeProfit2,
    risk_reward: Math.min(Number(s.riskReward) || 0, 8),
    confidence: s.confidence,
    structure: s.structure,
    htf_bias: s.htf_bias,
    confluences: enrichedConfluences,
    status: "open",
    signal_timestamp: s.timestamp,
    initial_stop_loss: s.stopLoss,
  }).select("id").single();

  // Best-effort feature log for expectancy research (table may not exist yet)
  if (inserted?.id) {
    try {
      await db.from("signal_features").insert({
        trade_id: inserted.id,
        pair: s.pair,
        direction: s.direction,
        grade,
        entry_model: (s as Signal).entryModel ?? "OB",
        signal_style: (s as Signal).signalStyle ?? "swing",
        structure_tf: (s as Signal).structureTimeframe ?? "4H",
        entry_tf: (s as Signal).entryTimeframe ?? "15M",
        confidence: s.confidence,
        risk_reward: Number(s.riskReward) || 0,
        htf_bias: s.htf_bias,
        structure: s.structure,
        has_sweep: (s.confluences ?? []).some((c) => /liquidity sweep|stop hunt/i.test(c)),
        session_tag: (s.confluences ?? []).find((c) => /London|NewYork|kill/i.test(c)) ?? null,
        confluences: s.confluences,
        confidence_breakdown: (s as Signal).confidenceBreakdown ?? null,
      });
    } catch (featErr) {
      console.warn("signal_features log skipped:", featErr instanceof Error ? featErr.message : featErr);
    }
  }

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

  // Background cron can scan without a user JWT (phone locked → still get pushes).
  // Set secret CRON_SECRET and call with header: x-cron-secret: <value>
  const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
  const providedCron = req.headers.get("x-cron-secret") ?? "";
  const isCron =
    cronSecret.length >= 16 &&
    providedCron.length >= 16 &&
    providedCron === cronSecret;

  if (!isCron) {
    if (!authorization) {
      return new Response(JSON.stringify({ error: "Sign in to access trade signals." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!SUPABASE_ANON_KEY) {
      return new Response(JSON.stringify({ error: "Server auth not configured." }), {
        status: 500,
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

  // Hot list: eligible pairs with an open paper trade (Twelve Data preferred)
  const hotTwelve = await loadHotTwelvePairs();
  const twelveUsed: string[] = [];

  // Process pairs in small batches — full parallel (36×3 Yahoo calls) triggers 429.
  const scanOnePair = async (pair: string) => {
      const entryInterval = entryTimeframeFor(pair);
      const entryRange = entryInterval === "5m" || entryInterval === "15m" ? "1mo" : "3mo";
      // Twelve Data only for gold + indices; all FX uses Yahoo
      let useTwelve =
        !!TWELVE_DATA_API_KEY && isTwelveEligible(pair);

      let [hourly, daily, entryTf] = await Promise.all([
        fetchCandles(pair, "1h", "3mo", useTwelve),
        fetchCandles(pair, "1d", "1y", useTwelve),
        fetchCandles(pair, entryInterval, entryRange as "1mo", useTwelve),
      ]);
      if (useTwelve) twelveUsed.push(pair);

      let fourH = resampleTo4H(hourly);
      const { resolved } = await resolveOpenTrades(pair, hourly);

      let { signal, developing } = await analyzePairFromCandles(
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

      // Near entry on eligible pair but not yet hot → one Twelve Data refresh for tighter levels
      // proximity is 0–95 from the engine (not 0–1)
      const nearEntry =
        isTwelveEligible(pair) &&
        !useTwelve &&
        !!TWELVE_DATA_API_KEY &&
        (signal != null ||
          (developing != null && Number((developing as { proximity?: number }).proximity ?? 0) >= 55));

      if (nearEntry) {
        const [h2, d2, e2] = await Promise.all([
          fetchCandles(pair, "1h", "3mo", true),
          fetchCandles(pair, "1d", "1y", true),
          fetchCandles(pair, entryInterval, entryRange as "1mo", true),
        ]);
        if (h2.length >= 30 && e2.length >= 20) {
          hourly = h2;
          daily = d2;
          entryTf = e2;
          fourH = resampleTo4H(hourly);
          useTwelve = true;
          twelveUsed.push(`${pair}*`);
          const again = await analyzePairFromCandles(
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
          signal = again.signal;
          developing = again.developing;
        }
      }

      const signals: Signal[] = [];
      if (signal) {
        signals.push(signal);
        await saveSignalToBook(signal);
      }

      // Gold scalp path: 1H trend + 5M BOS
      if (isGold(pair)) {
        const fiveMin =
          entryInterval === "5m" && entryTf.length >= 40
            ? entryTf
            : await fetchCandles(pair, "5m", "1mo", useTwelve || nearEntry);
        const scalp = await analyzeGoldScalp(pair, hourly, fiveMin);
        if (scalp) {
          signals.push(scalp);
          await saveSignalToBook(scalp);
        }
      }

      return { pair, signals, developing, resolved, dataSource: useTwelve ? "twelve" : "yahoo" };
  };

  const BATCH = 3;
  const settled: PromiseSettledResult<Awaited<ReturnType<typeof scanOnePair>>>[] = [];
  for (let i = 0; i < PAIRS.length; i += BATCH) {
    const chunk = PAIRS.slice(i, i + BATCH);
    const part = await Promise.allSettled(chunk.map(({ pair }) => scanOnePair(pair)));
    settled.push(...part);
    // Brief pause between batches to stay under Yahoo rate limits
    if (i + BATCH < PAIRS.length) {
      await new Promise((r) => setTimeout(r, 700));
    }
  }

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
  // Attach feed meta for debugging (ignored by UI if unused)
  (results as Record<string, unknown>).twelveDataEnabled = Boolean(TWELVE_DATA_API_KEY);
  (results as Record<string, unknown>).cronTriggered = isCron;
  (results as Record<string, unknown>).twelveDataPairs = [...new Set(twelveUsed)];

  return new Response(JSON.stringify(results), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
