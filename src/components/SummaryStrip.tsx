import { Activity, Radar, Gauge, ScanLine, Target } from "lucide-react";
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
  const aPlus = signals.filter((s) => s.setupGrade === "A+").length;
  const avgConf = signals.length
    ? Math.round(signals.reduce((a, s) => a + s.confidence, 0) / signals.length)
    : null;

  const items = [
    {
      icon: Target,
      label: "Swing signals",
      value: signals.length,
      sub: signals.length ? (
        <>
          <span className="text-bull">{buys} long</span>
          {" · "}
          <span className="text-bear">{sells} short</span>
          {aPlus > 0 && (
            <>
              {" · "}
              <span className="text-primary">{aPlus} A+</span>
            </>
          )}
        </>
      ) : (
        "No armed swing setups"
      ),
      highlight: signals.length > 0,
    },
    {
      icon: Radar,
      label: "Watchlist",
      value: developing.length,
      sub: "Alert only — not entries",
      highlight: false,
    },
    {
      icon: Gauge,
      label: "Avg confidence",
      value: avgConf === null ? "—" : `${avgConf}%`,
      sub: "Targets fixed at 2R / 4R",
    },
    {
      icon: Activity,
      label: "Desk mode",
      value: "Swing",
      sub: "Daily zone limits only",
      highlight: true,
      gold: true,
    },
    {
      icon: ScanLine,
      label: "Scanned",
      value: scanned,
      sub: failed ? <span className="text-bear">{failed} failed</span> : "Feeds healthy",
    },
  ];

  return (
    <div className="mb-6 grid grid-cols-2 gap-2 sm:gap-3 md:grid-cols-3 lg:grid-cols-5">
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
            loading && "opacity-70",
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <Icon
              className={cn(
                "h-3.5 w-3.5",
                gold && highlight ? "text-primary" : "text-muted-foreground/70",
              )}
            />
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {label}
            </span>
          </div>
          <p
            className={cn(
              "mt-2 font-mono text-xl font-semibold tabular-nums tracking-tight",
              gold && highlight && "text-primary",
            )}
          >
            {value}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">{sub}</p>
        </div>
      ))}
    </div>
  );
};

export default SummaryStrip;
