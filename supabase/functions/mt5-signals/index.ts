// MT5 signal feed — read-only.
// An Expert Advisor polls this endpoint with a private token header and receives
// the current signal book in a flat, MQL-friendly JSON shape.
// This function NEVER places trades and never mutates the strategy.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { toMt5Symbol } from "./symbols.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-ea-token",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const TIMEFRAME = "H4";

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // --- Auth: private EA token, never the publishable key ---------------------
  const url = new URL(req.url);
  const raw =
    req.headers.get("x-ea-token") ??
    req.headers.get("X-EA-Token") ??
    url.searchParams.get("token") ??
    "";

  if (!raw || raw.length < 20) {
    return json({ error: "Missing or malformed EA token" }, 401);
  }

  const hash = await sha256Hex(raw.trim());
  const { data: token } = await db
    .from("ea_tokens")
    .select("id, risk_percent, symbol_suffix, revoked")
    .eq("token_hash", hash)
    .maybeSingle();

  if (!token || token.revoked) {
    return json({ error: "Invalid or revoked EA token" }, 401);
  }

  // --- Query params ----------------------------------------------------------
  const statusParam = (url.searchParams.get("status") ?? "open").toLowerCase();
  const since = url.searchParams.get("since");
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 100)));

  let q = db
    .from("trades")
    .select(
      "id, pair, direction, entry, stop_loss, take_profit, take_profit_2, risk_reward, confidence, status, signal_timestamp, tp1_hit, closed_at, close_price",
    )
    .order("signal_timestamp", { ascending: false })
    .limit(limit);

  if (statusParam !== "all") {
    const wanted = statusParam.split(",").map((s) => s.trim()).filter(Boolean);
    q = wanted.length > 1 ? q.in("status", wanted) : q.eq("status", wanted[0] ?? "open");
  }
  if (since) q = q.gte("signal_timestamp", since);

  const { data: rows, error } = await q;
  if (error) return json({ error: error.message }, 500);

  const suffix = token.symbol_suffix ?? "";
  const riskPercent = Number(token.risk_percent ?? 1);

  const signals = (rows ?? []).map((t) => ({
    signal_id: t.id,
    symbol: toMt5Symbol(t.pair as string, suffix),
    pair: t.pair,
    direction: t.direction,
    entry: Number(t.entry),
    stop_loss: Number(t.stop_loss),
    take_profit: Number(t.take_profit),
    take_profit_2: t.take_profit_2 == null ? null : Number(t.take_profit_2),
    risk_percent: riskPercent,
    timeframe: TIMEFRAME,
    signal_time: t.signal_timestamp,
    status: t.status,
    tp1_hit: !!t.tp1_hit,
    risk_reward: Number(t.risk_reward),
    confidence: Number(t.confidence),
    closed_at: t.closed_at,
    close_price: t.close_price == null ? null : Number(t.close_price),
  }));

  // Best-effort telemetry; never blocks the response payload.
  await db
    .from("ea_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", token.id);

  return json({
    server_time: new Date().toISOString(),
    timeframe: TIMEFRAME,
    count: signals.length,
    signals,
  });
});
