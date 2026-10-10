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

interface Trade {
  status: "open" | "win" | "loss";
  risk_reward: number;
  closed_at: string | null;
  opened_at: string;
}

interface Point {
  t: number;
  label: string;
  cumR: number;
}

export const EquityCurve = () => {
  const [data, setData] = useState<Point[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const { data: rows } = await supabase
        .from("trades")
        .select("status, risk_reward, closed_at, opened_at")
        .in("status", ["win", "loss"])
        .order("closed_at", { ascending: true })
        .limit(1000);
      if (!rows) {
        setLoading(false);
        return;
      }
      let cum = 0;
      const points: Point[] = [{ t: 0, label: "Start", cumR: 0 }];
      (rows as Trade[]).forEach((r, i) => {
        cum += r.status === "win" ? Number(r.risk_reward) : -1;
        const d = new Date(r.closed_at ?? r.opened_at);
        points.push({
          t: i + 1,
          label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
          cumR: Number(cum.toFixed(2)),
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

  return (
    <section className="mt-10">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          <TrendingUp className="mr-2 inline h-3.5 w-3.5" />
          Equity Curve (Cumulative R)
        </h2>
        {data.length > 1 && (
          <span
            className={`font-mono text-xs font-semibold ${
              isPositive ? "text-bull" : "text-bear"
            }`}
          >
            {isPositive ? "+" : ""}
            {finalR.toFixed(1)}R · {data.length - 1} trades
          </span>
        )}
      </div>

      <div className="rounded-xl border border-border/60 surface-1 p-4">
        {loading ? (
          <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
            Loading…
          </div>
        ) : data.length <= 1 ? (
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
                  formatter={(v: number) => [`${v}R`, "Cumulative"]}
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
    </section>
  );
};
