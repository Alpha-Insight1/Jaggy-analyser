import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";

interface Trade {
  pair: string;
  status: "open" | "win" | "loss";
  risk_reward: number;
}

interface PairStat {
  pair: string;
  wins: number;
  losses: number;
  open: number;
  total: number;
  winRate: number;
  netR: number;
}

export const PerPairStats = () => {
  const [stats, setStats] = useState<PairStat[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase
        .from("trades")
        .select("pair, status, risk_reward")
        .limit(1000);
      if (!data) {
        setLoading(false);
        return;
      }
      const grouped = new Map<string, PairStat>();
      for (const t of data as Trade[]) {
        const s = grouped.get(t.pair) ?? {
          pair: t.pair,
          wins: 0,
          losses: 0,
          open: 0,
          total: 0,
          winRate: 0,
          netR: 0,
        };
        s.total++;
        if (t.status === "win") {
          s.wins++;
          s.netR += Number(t.risk_reward);
        } else if (t.status === "loss") {
          s.losses++;
          s.netR -= 1;
        } else {
          s.open++;
        }
        grouped.set(t.pair, s);
      }
      const arr = Array.from(grouped.values()).map((s) => ({
        ...s,
        winRate:
          s.wins + s.losses > 0
            ? Math.round((s.wins / (s.wins + s.losses)) * 100)
            : 0,
      }));
      arr.sort((a, b) => b.netR - a.netR);
      setStats(arr);
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
    <section className="mt-10">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          <BarChart3 className="mr-2 inline h-3.5 w-3.5" />
          Per-Pair Performance
        </h2>
      </div>

      <div className="overflow-hidden rounded-xl border border-border/60 surface-1">
        {loading ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Loading…</div>
        ) : stats.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            No data yet. Stats appear once trades resolve.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="surface-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Pair</th>
                  <th className="px-3 py-2 text-right">Trades</th>
                  <th className="px-3 py-2 text-right">Wins</th>
                  <th className="px-3 py-2 text-right">Losses</th>
                  <th className="px-3 py-2 text-right">Open</th>
                  <th className="px-3 py-2 text-right">Win Rate</th>
                  <th className="px-3 py-2 text-right">Net R</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40 font-mono tabular-nums">
                {stats.map((s) => (
                  <tr key={s.pair} className="transition-smooth hover:surface-2">
                    <td className="px-3 py-2 font-semibold">{s.pair}</td>
                    <td className="px-3 py-2 text-right">{s.total}</td>
                    <td className="px-3 py-2 text-right text-bull">{s.wins}</td>
                    <td className="px-3 py-2 text-right text-bear">{s.losses}</td>
                    <td className="px-3 py-2 text-right text-gold">{s.open}</td>
                    <td
                      className={cn(
                        "px-3 py-2 text-right font-semibold",
                        s.winRate >= 50 ? "text-bull" : "text-bear",
                      )}
                    >
                      {s.wins + s.losses > 0 ? `${s.winRate}%` : "—"}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-2 text-right font-semibold",
                        s.netR >= 0 ? "text-bull" : "text-bear",
                      )}
                    >
                      {s.netR >= 0 ? "+" : ""}
                      {s.netR.toFixed(1)}R
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
};
