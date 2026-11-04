import { Activity, Gauge, Radar, ScanLine, Target } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Signal } from "@/components/SignalCard";
import type { DevelopingSetup } from "@/components/DevelopingSetupCard";

interface SummaryStripProps {
  signals: Signal[];
  developing: DevelopingSetup[];
  scanned: number;
  failed: number;
  loading?: boolean;
}

export function SummaryStrip({
  signals,
  developing,
  scanned,
  failed,
  loading,
}: SummaryStripProps) {
  const buys = signals.filter((s) => s.direction === "BUY").length;
  const sells = signals.length - buys;
  const aPlus = signals.filter((s) => s.setupGrade === "A+").length;
  const avgConf = signals.length
    ? Math.round(signals.reduce((a, s) => a + s.confidence, 0) / signals.length)
    : null;

  const items = [
    {
      icon: Target,
      label: "Live signals",
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
        "Waiting for setup"
      ),
      highlight: signals.length > 0,
    },
    {
      icon: Radar,
      label: "Developing",
      value: developing.length,
      sub: "Not live yet",
      highlight: false,
    },
    {
      icon: Gauge,
      label: "Avg confidence",
      value: avgConf === null ? "—" : `${avgConf}%`,
      sub: "LTF entry on book",
    },
    {
      icon: Activity,
      label: "Desk",
      value: "Jaggy",
      sub: "SMC · LTF trigger",
      highlight: true,
      gold: true,
    },
    {
      icon: ScanLine,
      label: "Universe",
      value: scanned,
      sub: failed ? <span className="text-bear">{failed} failed</span> : "Feeds OK",
    },
  ];

  return (
    <div className="mb-8 grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-3 lg:grid-cols-5">
      {items.map(({ icon: Icon, label, value, sub, highlight, gold }) => (
        <div
          key={label}
          className={cn(
            "relative overflow-hidden rounded-xl border p-3.5 sm:p-4 transition-smooth",
            gold && highlight
              ? "border-primary/35 bg-gradient-to-br from-primary/10 to-transparent"
              : highlight
                ? "border-border/70 bg-card/80"
                : "border-border/40 bg-card/40",
            loading && "opacity-60",
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <Icon
              className={cn(
                "h-3.5 w-3.5",
                gold && highlight ? "text-primary" : "text-muted-foreground/70",
              )}
            />
            <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {label}
            </span>
          </div>
          <p
            className={cn(
              "mt-2 font-mono text-2xl font-semibold tracking-tight tabular-nums",
              gold && highlight && "text-primary",
            )}
          >
            {value}
          </p>
          <div className="mt-1 text-[11px] text-muted-foreground">{sub}</div>
        </div>
      ))}
    </div>
  );
}

export default SummaryStrip;
