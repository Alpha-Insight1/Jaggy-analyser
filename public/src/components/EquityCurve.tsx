import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { TrendingUp } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { realizedR, type TradeRow } from "@/lib/tradeStats";

interface Point {
  t: number;
  label: string;
  cumR: number;
  tradeR: number;
  pair: string;
}

export const EquityCurve = () => {
  const [data, setData] = useState<Point[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const { data: rows } = await supabase
        .from("trades")
        .select(
          "pair, status, direction, entry, stop_loss, initial_stop_loss, close_price, risk_reward, closed_at, opened_at, tp1_hit, protection_active",
        )
        .in("status", ["win", "loss"])
        .order("closed_at", { ascending: true })
        .limit(2000);

      if (!rows) {
        setLoading(false);
        return;
      }

      // Sort by close time (nulls last → use opened_at)
      const sorted = [...(rows as TradeRow[])].sort((a, b) => {
        const ta = new Date(a.closed_at ?? a.opened_at ?? 0).getTime();
        const tb = new Date(b.closed_at ?? b.opened_at ?? 0).getTime();
        return ta - tb;
      });

      let cum = 0;
      const points: Point[] = [{ t: 0, label: "Start", cumR: 0, tradeR: 0, pair: "" }];

      sorted.forEach((r, i) => {
        const tradeR = realizedR(r);
        cum += tradeR;
        const d = new Date(r.closed_at ?? r.opened_at ?? Date.now());
        points.push({
          t: i + 1,
          label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
          cumR: Number(cum.toFixed(2)),
          tradeR: Number(tradeR.toFixed(2)),
          pair: r.pair ?? "",
        });
      });

      setData(points);
      setLoading(false);
    };

    load();

    const channel = supabase
      .channel("trades-equity")
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

  const finalR = data.length ? data[data.length - 1].cumR : 0;
  const isPositive = finalR >= 0;
  const tradeCount = Math.max(0, data.length - 1);

  return (
    <section className="mt-10">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          <TrendingUp className="mr-2 inline h-3.5 w-3.5" />
          Equity curve (cumulative R)
        </h2>
        {tradeCount > 0 && (
          <span
            className={`font-mono text-xs font-semibold ${
              isPositive ? "text-bull" : "text-bear"
            }`}
          >
            {isPositive ? "+" : ""}
            {finalR.toFixed(2)}R · {tradeCount} closed
          </span>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-border/60 surface-1 p-4">
        {loading ? (
          <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
            Loading…
          </div>
        ) : tradeCount === 0 ? (
          <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
            No closed trades yet. Curve appears as positions resolve.
          </div>
        ) : (
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <defs>
                  <linearGradient id="bullGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--bull))" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="hsl(var(--bull))" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="bearGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--bear))" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="hsl(var(--bear))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="hsl(var(--border))"
                  opacity={0.4}
                />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                  stroke="hsl(var(--border))"
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                  stroke="hsl(var(--border))"
                  tickFormatter={(v) => `${v}R`}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--popover))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "0.5rem",
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "hsl(var(--muted-foreground))" }}
                  formatter={(v: number, name: string) => {
                    if (name === "cumR") return [`${v}R`, "Cumulative"];
                    return [`${v}R`, name];
                  }}
                  labelFormatter={(_, payload) => {
                    const p = payload?.[0]?.payload as Point | undefined;
                    if (!p || p.t === 0) return "Start";
                    return `${p.pair} · ${p.tradeR >= 0 ? "+" : ""}${p.tradeR}R · ${p.label}`;
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="cumR"
                  stroke={isPositive ? "hsl(var(--bull))" : "hsl(var(--bear))"}
                  strokeWidth={2}
                  fill={isPositive ? "url(#bullGrad)" : "url(#bearGrad)"}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
      {tradeCount > 0 && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Each step uses realized R from close price vs initial stop (same math as trade book /
          last 30 days). Hover a point to see pair and that trade’s R.
        </p>
      )}
    </section>
  );
};
