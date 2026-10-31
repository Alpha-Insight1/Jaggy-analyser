import { Activity, Radar, Gauge, ScanLine, ArrowUpDown, Zap } from "lucide-react";
import type { Signal } from "@/components/SignalCard";
import type { DevelopingSetup } from "@/components/DevelopingSetupCard";
import { cn } from "@/lib/utils";

interface Props {
  signals: Signal[];
  developing: DevelopingSetup[];
  scanned: number;
  failed: number;
  loading: boolean;
}

export const SummaryStrip = ({ signals, developing, scanned, failed, loading }: Props) => {
  const buys = signals.filter((s) => s.direction === "BUY").length;
  const sells = signals.length - buys;
  const scalps = signals.filter((s) => s.signalStyle === "scalp").length;
  const swings = signals.length - scalps;
  const avgConf = signals.length
    ? Math.round(signals.reduce((a, s) => a + s.confidence, 0) / signals.length)
    : null;
  const avgRR = signals.length
    ? (signals.reduce((a, s) => a + s.riskReward, 0) / signals.length).toFixed(1)
    : null;

  const items = [
    {
      icon: Activity,
      label: "Active signals",
      value: signals.length,
      sub: signals.length ? (
        <>
          <span className="text-bull">{buys} long</span>
          {" · "}
          <span className="text-bear">{sells} short</span>
        </>
      ) : (
        "No qualified setups"
      ),
      highlight: signals.length > 0,
    },
    {
      icon: Zap,
      label: "Gold scalps",
      value: scalps,
      sub: scalps ? "1H → 5M BOS active" : "None right now",
      highlight: scalps > 0,
      gold: true,
    },
    {
      icon: Radar,
      label: "Developing",
      value: developing.length,
      sub: `${developing.filter((d) => d.newsMomentum).length} news-driven`,
    },
    {
      icon: Gauge,
      label: "Avg confidence",
      value: avgConf === null ? "—" : `${avgConf}%`,
      sub: avgRR === null ? (swings ? `${swings} swing` : "Awaiting signals") : `Avg R:R 1:${avgRR}`,
    },
    {
      icon: ScanLine,
      label: "Scanned",
      value: scanned,
      sub: failed ? <span className="text-bear">{failed} failed</span> : "Feeds healthy",
    },
  ];

  return (
    <div className="mb-6 sm:mb-8 grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-3 lg:grid-cols-5">
      {items.map(({ icon: Icon, label, value, sub, highlight, gold }) => (
        <div
          key={label}
          className={cn(
            "rounded-lg border p-4 shadow-card transition-smooth",
            gold && highlight
              ? "border-primary/40 bg-primary/5"
              : highlight
                ? "border-border/80 surface-1"
                : "border-border/50 surface-1",
            loading && "animate-pulse",
          )}
        >
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {label}
            </p>
            <Icon className={cn("h-3.5 w-3.5", gold && highlight ? "text-gold" : "text-muted-foreground/70")} />
          </div>
          <p
            className={cn(
              "mt-2 font-mono text-2xl font-semibold tabular-nums tracking-tight",
              gold && highlight && "text-gold",
            )}
          >
            {value}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{sub}</p>
        </div>
      ))}
    </div>
  );
};
