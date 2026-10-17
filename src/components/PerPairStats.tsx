import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { BarChart3, CalendarRange, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  aggregate,
  realizedR,
  styleOf,
  withinLastDays,
  type StyleBucket,
  type TradeRow,
} from "@/lib/tradeStats";

interface PairStat {
  pair: string;
  style: StyleBucket;
  wins: number;
  losses: number;
  open: number;
  winRate: number;
  netR: number;
}

interface StyleStat {
  style: StyleBucket;
  wins: number;
  losses: number;
  winRate: number;
  netR: number;
  trades: number;
}

const STYLE_ORDER: StyleBucket[] = ["Forex", "Gold", "Crypto", "Indices", "Other"];

export const PerPairStats = () => {
  const [pairStats, setPairStats] = useState<PairStat[]>([]);
  const [styleStats, setStyleStats] = useState<StyleStat[]>([]);
  const [last30, setLast30] = useState({ trades: 0, wins: 0, losses: 0, winRate: 0, netR: 0, avgR: 0 });
  const [allTime, setAllTime] = useState({ trades: 0, wins: 0, losses: 0, winRate: 0, netR: 0, avgR: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from("trades")
        .select(
          "pair, status, direction, entry, stop_loss, initial_stop_loss, close_price, risk_reward, closed_at, opened_at, tp1_hit, protection_active, structure",
        )
        .limit(2000);

      if (!data) {
        setLoading(false);
        return;
      }

      const rows = data as TradeRow[];
      const closed = rows.filter((t) => t.status === "win" || t.status === "loss");
      const last30Rows = closed.filter((t) => withinLastDays(t.closed_at, 30));

      setLast30(aggregate(last30Rows));
      setAllTime(aggregate(closed));

      // Per style
      const byStyle = new Map<StyleBucket, TradeRow[]>();
      for (const t of closed) {
        const s = styleOf(t.pair, t.structure);
        const list = byStyle.get(s) ?? [];
        list.push(t);
        byStyle.set(s, list);
      }
      const styles: StyleStat[] = STYLE_ORDER.map((style) => {
        const list = byStyle.get(style) ?? [];
        const a = aggregate(list);
        return {
          style,
          trades: a.trades,
          wins: a.wins,
          losses: a.losses,
          winRate: a.winRate,
          netR: a.netR,
        };
      }).filter((s) => s.trades > 0);
      setStyleStats(styles);

      // Per pair
      const grouped = new Map<string, PairStat>();
      for (const t of rows) {
        const s = grouped.get(t.pair) ?? {
          pair: t.pair,
          style: styleOf(t.pair, t.structure),
          wins: 0,
          losses: 0,
          open: 0,
          winRate: 0,
          netR: 0,
        };
        if (t.status === "win") {
          s.wins++;
          s.netR += realizedR(t);
        } else if (t.status === "loss") {
          s.losses++;
          s.netR += realizedR(t);
        } else if (t.status === "open") {
          s.open++;
        }
        grouped.set(t.pair, s);
      }
      const arr = Array.from(grouped.values()).map((s) => ({
        ...s,
        winRate:
          s.wins + s.losses > 0 ? Math.round((s.wins / (s.wins + s.losses)) * 100) : 0,
      }));
      arr.sort((a, b) => b.netR - a.netR);
      setPairStats(arr);
      setLoading(false);
    };

    load();

    const channel = supabase
      .channel("trades-perpair")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "trades" },
        () => load(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return (
    <section className="mt-10 space-y-6">
      {/* Last 30 days — primary P/L readout */}
      <div
        className={cn(
          "rounded-xl border p-5",
          last30.trades === 0
            ? "border-border/60 surface-1"
            : last30.netR >= 0
              ? "border-bull/40 bg-bull/5 ring-1 ring-bull/10"
              : "border-bear/40 bg-bear/5 ring-1 ring-bear/10",
        )}
      >
        <div className="mb-3 flex items-center gap-2">
          <CalendarRange className="h-4 w-4 text-gold" />
          <h2 className="text-sm font-semibold tracking-tight">Last 30 days (paper)</h2>
        </div>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Metric
              label="Closed trades"
              value={String(last30.trades)}
            />
            <Metric label="Win rate" value={last30.trades ? `${last30.winRate}%` : "—"} gold />
            <Metric label="Wins" value={String(last30.wins)} tone="bull" />
            <Metric label="Losses" value={String(last30.losses)} tone="bear" />
            <Metric
              label="Net R"
              value={
                last30.trades === 0
                  ? "—"
                  : `${last30.netR >= 0 ? "+" : ""}${last30.netR.toFixed(2)}R`
              }
              tone={last30.netR >= 0 ? "bull" : "bear"}
              large
            />
          </div>
        )}
        {!loading && last30.trades > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            Avg {last30.avgR >= 0 ? "+" : ""}
            {last30.avgR.toFixed(2)}R per closed trade
            {allTime.trades > last30.trades && (
              <>
                {" · "}
                All-time: {allTime.netR >= 0 ? "+" : ""}
                {allTime.netR.toFixed(2)}R over {allTime.trades} trades
              </>
            )}
          </p>
        )}
        {!loading && last30.trades === 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            No closed paper trades in the last 30 days yet.
          </p>
        )}
      </div>

      {/* By style: Forex / Gold / Crypto / Indices */}
      <div className="rounded-xl border border-border/60 surface-1 p-5">
        <div className="mb-4 flex items-center gap-2">
          <Layers className="h-4 w-4 text-gold" />
          <h2 className="text-sm font-semibold tracking-tight">Performance by style</h2>
        </div>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : styleStats.length === 0 ? (
          <p className="text-sm text-muted-foreground">No closed trades to group yet.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {styleStats.map((s) => (
              <div
                key={s.style}
                className={cn(
                  "rounded-lg border p-4",
                  s.netR >= 0 ? "border-border/60 surface-2" : "border-bear/30 bg-bear/5",
                )}
              >
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {s.style}
                  {s.style === "Crypto" && " (BTC etc.)"}
                  {s.style === "Gold" && " (XAU)"}
                </p>
                <p
                  className={cn(
                    "mt-1 font-mono text-2xl font-bold tabular-nums",
                    s.netR >= 0 ? "text-bull" : "text-bear",
                  )}
                >
                  {s.netR >= 0 ? "+" : ""}
                  {s.netR.toFixed(1)}R
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {s.winRate}% win · {s.wins}W / {s.losses}L · {s.trades} trades
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Per pair table */}
      <div>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            <BarChart3 className="mr-2 inline h-3.5 w-3.5" />
            Per-pair performance
          </h2>
        </div>

        <div className="overflow-hidden rounded-xl border border-border/60 surface-1">
          {loading ? (
            <div className="p-6 text-center text-sm text-muted-foreground">Loading…</div>
          ) : pairStats.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No trades recorded yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="surface-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Pair</th>
                    <th className="px-3 py-2 text-left">Style</th>
                    <th className="px-3 py-2 text-right">W</th>
                    <th className="px-3 py-2 text-right">L</th>
                    <th className="px-3 py-2 text-right">Open</th>
                    <th className="px-3 py-2 text-right">Win %</th>
                    <th className="px-3 py-2 text-right">Net R</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40 font-mono tabular-nums">
                  {pairStats.map((s) => (
                    <tr key={s.pair}>
                      <td className="px-3 py-2 text-left font-semibold">{s.pair}</td>
                      <td className="px-3 py-2 text-left text-muted-foreground">{s.style}</td>
                      <td className="px-3 py-2 text-right text-bull">{s.wins}</td>
                      <td className="px-3 py-2 text-right text-bear">{s.losses}</td>
                      <td className="px-3 py-2 text-right text-muted-foreground">{s.open}</td>
                      <td className="px-3 py-2 text-right">
                        {s.wins + s.losses > 0 ? `${s.winRate}%` : "—"}
                      </td>
                      <td
                        className={cn(
                          "px-3 py-2 text-right font-semibold",
                          s.netR > 0 ? "text-bull" : s.netR < 0 ? "text-bear" : "text-muted-foreground",
                        )}
                      >
                        {s.wins + s.losses === 0
                          ? "—"
                          : `${s.netR >= 0 ? "+" : ""}${s.netR.toFixed(1)}R`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};

function Metric({
  label,
  value,
  tone,
  gold,
  large,
}: {
  label: string;
  value: string;
  tone?: "bull" | "bear";
  gold?: boolean;
  large?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border/50 surface-2 p-3">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 font-mono font-semibold tabular-nums",
          large ? "text-2xl" : "text-lg",
          gold && "text-gold",
          tone === "bull" && "text-bull",
          tone === "bear" && "text-bear",
        )}
      >
        {value}
      </p>
    </div>
  );
};
