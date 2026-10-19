import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ArrowDown, ArrowUp, BookOpen, CheckCircle2, XCircle, Clock, Ban } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { realizedR as sharedRealizedR } from "@/lib/tradeStats";

interface Trade {
  id: string;
  pair: string;
  direction: "BUY" | "SELL";
  entry: number;
  stop_loss: number;
  take_profit: number;
  risk_reward: number;
  confidence: number;
  structure: string;
  status: "open" | "win" | "loss";
  opened_at: string;
  closed_at: string | null;
  close_price: number | null;
  initial_stop_loss: number | null;
  protection_active: boolean;
  tp1_hit?: boolean;
}

interface TradeBookProps {
  /** Map of pair -> latest scanned price, used to mark-to-market open trades. */
  priceMap?: Record<string, number>;
}

export const TradeBook = ({ priceMap = {} }: TradeBookProps) => {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [closedTrades, setClosedTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState<string | null>(null);

  const refreshTrades = useCallback(async () => {
    const [openRes, closedRes] = await Promise.all([
      supabase
        .from("trades")
        .select("*")
        .eq("status", "open")
        .order("opened_at", { ascending: false }),
      supabase
        .from("trades")
        .select("*")
        .neq("status", "open")
        .order("closed_at", { ascending: false })
        .limit(1000),
    ]);
    if (!openRes.error && openRes.data) setTrades(openRes.data as Trade[]);
    if (!closedRes.error && closedRes.data) setClosedTrades(closedRes.data as Trade[]);
    setLoading(false);
  }, []);

  /** Manual close at current scan price (or entry if no price). */
  const manualClose = useCallback(
    async (t: Trade, as: "win" | "loss") => {
      if (actingId) return;
      setActingId(t.id);
      const px = priceMap[t.pair];
      const isBuy = t.direction === "BUY";
      let closePrice: number;
      if (as === "loss") {
        closePrice = Number(t.initial_stop_loss ?? t.stop_loss);
      } else if (px != null) {
        closePrice = px;
      } else {
        closePrice = Number(t.entry);
      }
      // If user marks win but price is worse than entry, still allow — they know their fill
      const { error } = await supabase
        .from("trades")
        .update({
          status: as,
          close_price: closePrice,
          closed_at: new Date().toISOString(),
        })
        .eq("id", t.id)
        .eq("status", "open");
      setActingId(null);
      if (error) {
        toast.error("Could not close trade", {
          description: error.message + " — you may need the trades UPDATE policy (see README).",
        });
        return;
      }
      toast.success(as === "win" ? "Closed as win" : "Closed as loss", {
        description: `${t.pair} @ ${closePrice}`,
      });
      void refreshTrades();
    },
    [actingId, priceMap, refreshTrades],
  );

  /** Skip = remove bad auto-entry from the book (does not count in win rate). */
  const skipTrade = useCallback(
    async (t: Trade) => {
      if (actingId) return;
      if (!confirm(`Skip ${t.pair} ${t.direction}? It will be removed and not count in stats.`)) return;
      setActingId(t.id);
      const { error } = await supabase.from("trades").delete().eq("id", t.id).eq("status", "open");
      setActingId(null);
      if (error) {
        toast.error("Could not skip trade", {
          description: error.message + " — you may need DELETE permission on trades.",
        });
        return;
      }
      toast.message("Trade skipped", { description: `${t.pair} removed from book` });
      void refreshTrades();
    },
    [actingId, refreshTrades],
  );

  useEffect(() => {
    refreshTrades();

    // Re-load on tab focus so SL/TP fills are reflected immediately when
    // the user returns to the app.
    const onFocus = () => refreshTrades();
    window.addEventListener("focus", onFocus);

    // Realtime updates
    const channel = supabase
      .channel("trades-changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "trades" },
        (payload) => {
          const oldTrade = payload.old as Partial<Trade>;
          const newTrade = payload.new as Partial<Trade>;
          if (oldTrade.status === "open" && newTrade.status && newTrade.status !== "open") {
            toast(newTrade.status === "win" ? "Trade closed in profit" : "Trade closed at a loss", {
              description: `${newTrade.pair ?? "Trade"} · closed at ${newTrade.close_price ?? "market"}${
                newTrade.closed_at ? ` · ${new Date(newTrade.closed_at).toLocaleString()}` : ""
              }`,
            });
          }
          void refreshTrades();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshTrades]);


  // Live SL/TP guard: when the latest scanned price crosses an open trade's
  // SL or TP, close it client-side immediately so the book never lags the chart.
  // The backend resolver still reconciles authoritatively on the next scan.
  useEffect(() => {
    for (const t of trades) {
      if (t.status !== "open") continue;
      const px = priceMap[t.pair];
      if (px == null) continue;
      const isBuy = t.direction === "BUY";
      const sl = Number(t.stop_loss);
      const tp = Number(t.take_profit);
      const hitSL = isBuy ? px <= sl : px >= sl;
      const hitTP = isBuy ? px >= tp : px <= tp;
      if (!hitSL && !hitTP) continue;

      // Worst case: SL wins ties. After TP1, BE-stop is a scratch win.
      const status: "win" | "loss" = hitSL ? (t.tp1_hit || t.protection_active ? "win" : "loss") : "win";
      const closePrice = hitSL ? sl : tp;
      const closedAt = new Date().toISOString();

      supabase
        .from("trades")
        .update({ status, close_price: closePrice, closed_at: closedAt })
        .eq("id", t.id)
        .eq("status", "open")
        .then(({ error }) => {
          if (!error) {
            setTrades((prev) =>
              prev.map((x) =>
                x.id === t.id ? { ...x, status, close_price: closePrice, closed_at: closedAt } : x,
              ),
            );
            void refreshTrades();
          }
        });
    }
  }, [trades, priceMap, refreshTrades]);

  const openTrades = trades.filter((t) => t.status === "open");
  const closed = closedTrades;
  const wins = closed.filter((t) => t.status === "win").length;
  const losses = closed.filter((t) => t.status === "loss").length;
  const open = openTrades.length;
  const winRate = closed.length ? Math.round((wins / closed.length) * 100) : 0;
  // Realized R uses the actual fill price when we have it, so break-even exits
  // score ~0R instead of being counted as a full-target win.
  const totalR = closed.reduce((acc, t) => {
    const realized = realizedR(t);
    return acc + realized;
  }, 0);


  // Unrealized R across all currently-open trades (mark-to-market).
  const openPnl = openTrades.reduce((acc, t) => {
    const px = priceMap[t.pair];
    if (px == null) return acc;
    const r = computeR(t, px);
    return r == null ? acc : acc + r;
  }, 0);

  return (
    <section className="mt-10">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b border-border/50 pb-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md border border-border/60 surface-2">
            <BookOpen className="h-4 w-4 text-gold" />
          </div>
          <div>
            <h2 className="text-sm font-semibold tracking-tight">Your active trades</h2>
            <p className="text-xs text-muted-foreground">
              Live positions from signals · auto mark-to-market
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {open > 0 ? (
            <span className="rounded-full border border-bull/40 bg-bull/10 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-bull">
              {open} open
            </span>
          ) : (
            <span className="rounded-full border border-border/60 surface-2 px-2.5 py-0.5 text-[11px] text-muted-foreground">
              No open positions
            </span>
          )}
          <span className="text-xs text-muted-foreground">{closed.length} closed</span>
        </div>
      </div>

      {/* Overall closed R — primary performance readout */}
      <div
        className={
          closed.length === 0
            ? "mb-4 rounded-xl border border-border/60 surface-1 p-5"
            : totalR >= 0
              ? "mb-4 rounded-xl border border-bull/40 bg-bull/5 p-5 ring-1 ring-bull/15"
              : "mb-4 rounded-xl border border-bear/40 bg-bear/5 p-5 ring-1 ring-bear/15"
        }
      >
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Overall closed R
            </p>
            <p
              className={
                "mt-1 font-mono text-3xl font-bold tabular-nums tracking-tight " +
                (closed.length === 0
                  ? "text-muted-foreground"
                  : totalR >= 0
                    ? "text-bull"
                    : "text-bear")
              }
            >
              {closed.length === 0
                ? "—"
                : `${totalR >= 0 ? "+" : ""}${totalR.toFixed(2)}R`}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {closed.length === 0
                ? "No closed trades yet — results appear here after SL/TP"
                : `Sum of all closed trades · ${wins}W / ${losses}L · avg ${
                    closed.length ? (totalR / closed.length).toFixed(2) : "0"
                  }R per trade`}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Win rate" value={closed.length ? `${winRate}%` : "—"} tone="gold" />
            <Stat label="Wins" value={String(wins)} tone="bull" />
            <Stat label="Losses" value={String(losses)} tone="bear" />
            <Stat
              label="Open P/L"
              value={open === 0 ? "—" : `${openPnl >= 0 ? "+" : ""}${openPnl.toFixed(2)}R`}
              tone={openPnl >= 0 ? "bull" : "bear"}
            />
          </div>
        </div>
      </div>

      {/* Open positions table */}
      <div
        className={
          openTrades.length > 0
            ? "overflow-hidden rounded-xl border border-bull/30 surface-1 ring-1 ring-bull/10"
            : "overflow-hidden rounded-xl border border-border/60 surface-1"
        }
      >
        <div className="flex items-center justify-between border-b border-border/50 surface-2 px-4 py-2.5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Open positions
          </p>
          {openTrades.length > 0 && (
            <p className="text-[11px] text-muted-foreground">
              P/L updates from live scan prices
            </p>
          )}
        </div>
        {loading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : openTrades.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm font-medium">No active trades</p>
            <p className="mt-1 text-xs text-muted-foreground">
              When a signal is taken, it appears here with live P/L until SL or TP is hit.
            </p>
          </div>
        ) : (
          <>
            {/* Mobile: stacked cards */}
            <div className="space-y-3 p-3 md:hidden">
              {openTrades.map((t) => {
                const isBuy = t.direction === "BUY";
                return (
                  <div
                    key={t.id}
                    className="rounded-lg border border-border/60 surface-2 p-3 space-y-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold">{t.pair}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          <span
                            className={
                              "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold " +
                              (isBuy ? "bg-bull/10 text-bull" : "bg-bear/10 text-bear")
                            }
                          >
                            {isBuy ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
                            {t.direction}
                          </span>
                          <StatusBadge status={t.status} />
                          {t.protection_active && (
                            <span className="text-[9px] font-bold uppercase text-bull">+1R protected</span>
                          )}
                          {t.tp1_hit && !t.protection_active && (
                            <span className="text-[9px] font-bold uppercase text-gold">TP1 · BE</span>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] uppercase text-muted-foreground">P/L</p>
                        <PnlCell trade={t} currentPrice={priceMap[t.pair]} />
                      </div>
                    </div>
                    <div className="grid grid-cols-3 gap-2 font-mono text-xs tabular-nums">
                      <div>
                        <p className="text-[10px] text-muted-foreground">Entry</p>
                        <p className="font-semibold">{t.entry}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-muted-foreground">SL</p>
                        <p className="font-semibold text-bear">{t.stop_loss}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-muted-foreground">TP</p>
                        <p className="font-semibold text-bull">{t.take_profit}</p>
                      </div>
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      Opened{" "}
                      {new Date(t.opened_at).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                    <div className="grid grid-cols-3 gap-2">
                      <button
                        type="button"
                        disabled={actingId === t.id}
                        onClick={() => void manualClose(t, "win")}
                        className="min-h-[40px] rounded-md border border-bull/40 bg-bull/10 text-xs font-semibold text-bull active:scale-[0.98] disabled:opacity-50"
                      >
                        Close win
                      </button>
                      <button
                        type="button"
                        disabled={actingId === t.id}
                        onClick={() => void manualClose(t, "loss")}
                        className="min-h-[40px] rounded-md border border-bear/40 bg-bear/10 text-xs font-semibold text-bear active:scale-[0.98] disabled:opacity-50"
                      >
                        Close loss
                      </button>
                      <button
                        type="button"
                        disabled={actingId === t.id}
                        onClick={() => void skipTrade(t)}
                        className="min-h-[40px] rounded-md border border-border/60 text-xs text-muted-foreground active:scale-[0.98] disabled:opacity-50"
                      >
                        Skip
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Desktop: table */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-xs">
                <thead className="surface-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Pair</th>
                    <th className="px-3 py-2 text-left">Side</th>
                    <th className="px-3 py-2 text-right">Entry</th>
                    <th className="px-3 py-2 text-right">SL</th>
                    <th className="px-3 py-2 text-right">TP</th>
                    <th className="px-3 py-2 text-right">P/L</th>
                    <th className="px-3 py-2 text-center">Status</th>
                    <th className="px-3 py-2 text-right">Opened</th>
                    <th className="px-3 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40 font-mono tabular-nums">
                  {openTrades.map((t) => {
                    const isBuy = t.direction === "BUY";
                    return (
                      <tr key={t.id} className="hover:surface-2 transition-smooth">
                        <td className="px-3 py-2 font-semibold">{t.pair}</td>
                        <td className="px-3 py-2">
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold",
                              isBuy ? "bg-bull/10 text-bull" : "bg-bear/10 text-bear"
                            )}
                          >
                            {isBuy ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
                            {t.direction}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">{t.entry}</td>
                        <td className="px-3 py-2 text-right">
                          <div className="flex flex-col items-end leading-tight">
                            <span className="text-bear">{t.stop_loss}</span>
                            {t.protection_active && t.status === "open" ? (
                              <span className="text-[9px] font-bold uppercase tracking-wider text-bull">
                                +2R · +1R protected
                              </span>
                            ) : t.tp1_hit && t.status === "open" ? (
                              <span className="text-[9px] font-bold uppercase tracking-wider text-gold">
                                BE · TP1 ✓
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right text-bull">{t.take_profit}</td>
                        <td className="px-3 py-2 text-right">
                          <PnlCell trade={t} currentPrice={priceMap[t.pair]} />
                        </td>
                        <td className="px-3 py-2 text-center">
                          <StatusBadge status={t.status} />
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground">
                          {new Date(t.opened_at).toLocaleString(undefined, {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="inline-flex flex-wrap items-center justify-end gap-1">
                            <button
                              type="button"
                              disabled={actingId === t.id}
                              onClick={() => void manualClose(t, "win")}
                              className="rounded border border-bull/40 bg-bull/10 px-1.5 py-0.5 text-[10px] font-semibold text-bull hover:bg-bull/20 disabled:opacity-50"
                            >
                              Close win
                            </button>
                            <button
                              type="button"
                              disabled={actingId === t.id}
                              onClick={() => void manualClose(t, "loss")}
                              className="rounded border border-bear/40 bg-bear/10 px-1.5 py-0.5 text-[10px] font-semibold text-bear hover:bg-bear/20 disabled:opacity-50"
                            >
                              Close loss
                            </button>
                            <button
                              type="button"
                              disabled={actingId === t.id}
                              onClick={() => void skipTrade(t)}
                              className="inline-flex items-center gap-0.5 rounded border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/40 disabled:opacity-50"
                            >
                              <Ban className="h-3 w-3" />
                              Skip
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {closed.length > 0 && (
        <div className="mt-4 rounded-xl border border-border/60 surface-1 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Recent closures
            </h3>
            <span className="text-[10px] text-muted-foreground">Latest 5 exits</span>
          </div>
          <div className="space-y-2">
            {closed.slice(0, 8).map((t) => {
              const r = realizedR(t);
              return (
              <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2">
                  <StatusBadge status={t.status} />
                  <span className="font-semibold">{t.pair}</span>
                  <span className="text-muted-foreground">{t.direction}</span>
                  <span
                    className={
                      "font-mono font-semibold tabular-nums " +
                      (r >= 0 ? "text-bull" : "text-bear")
                    }
                  >
                    {r >= 0 ? "+" : ""}
                    {r.toFixed(2)}R
                  </span>
                </div>
                <div className="flex items-center gap-3 font-mono tabular-nums text-muted-foreground">
                  <span>Exit {t.close_price ?? "—"}</span>
                  <span>{t.closed_at ? new Date(t.closed_at).toLocaleString() : "—"}</span>
                </div>
              </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
};

/**
 * Compute the R-multiple for a trade given current price.
 * R = (price-move-in-favor) / (initial-risk).  +1R = price reached TP-distance worth one risk unit.
 */
function computeR(t: Trade, price: number | undefined): number | null {
  if (price == null) return null;
  const risk = Math.abs(Number(t.entry) - Number(t.initial_stop_loss ?? t.stop_loss));
  if (!risk) return null;
  const move =
    t.direction === "BUY" ? price - Number(t.entry) : Number(t.entry) - price;
  return move / risk;
}

/**
 * Realized R for a closed trade.
 * Uses close_price vs initial risk. Backend sets close_price to the peak
 * favorable price when MFE exceeded the exit (e.g. +5R then BE → +5R).
 */
function realizedR(t: Trade): number {
  return sharedRealizedR(t);
}



const PnlCell = ({ trade, currentPrice }: { trade: Trade; currentPrice?: number }) => {
  // For closed trades, show realized R based on the recorded outcome.
  if (trade.status !== "open") {
    const r = realizedR(trade);
    const tone = r >= 0 ? "text-bull" : "text-bear";
    return (
      <span className={cn("font-semibold", tone)}>
        {r >= 0 ? "+" : ""}
        {r.toFixed(2)}R
      </span>
    );
  }

  // Open trade — mark-to-market with the latest scanned price.
  const r = computeR(trade, currentPrice);
  if (r == null) {
    return <span className="text-muted-foreground">—</span>;
  }
  const move =
    trade.direction === "BUY"
      ? Number(currentPrice) - Number(trade.entry)
      : Number(trade.entry) - Number(currentPrice);
  const tone = r >= 0 ? "text-bull" : "text-bear";
  // Pick decimals appropriate for the instrument's price magnitude.
  const decimals = Math.abs(Number(trade.entry)) >= 100 ? 2 : 5;
  return (
    <div className="flex flex-col items-end leading-tight">
      <span className={cn("font-semibold", tone)}>
        {r >= 0 ? "+" : ""}
        {r.toFixed(2)}R
      </span>
      <span className={cn("text-[10px]", tone, "opacity-80")}>
        {move >= 0 ? "+" : ""}
        {move.toFixed(decimals)}
      </span>
    </div>
  );
};

const Stat = ({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "bull" | "bear" | "gold";
}) => (
  <div className="rounded-xl border border-border/60 surface-1 p-4 shadow-card-elev">
    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
    <p
      className={cn(
        "mt-1 font-mono text-2xl font-bold tabular-nums",
        tone === "bull" && "text-bull",
        tone === "bear" && "text-bear",
        tone === "gold" && "text-gold"
      )}
    >
      {value}
    </p>
  </div>
);

const StatusBadge = ({ status }: { status: "open" | "win" | "loss" }) => {
  if (status === "win")
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-bull/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-bull">
        <CheckCircle2 className="h-3 w-3" /> TP Hit
      </span>
    );
  if (status === "loss")
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-bear/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-bear">
        <XCircle className="h-3 w-3" /> SL Hit
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-gold/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-gold">
      <Clock className="h-3 w-3" /> Open
    </span>
  );
};
