import { ArrowDown, ArrowUp, Zap, Clock, Activity, Shield, Target } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DevelopingSetup {
  pair: string;
  direction: "BUY" | "SELL";
  htf_bias: "Bullish" | "Bearish";
  reason: string;
  proximity: number;
  currentPrice: number;
  newsMomentum: boolean;
  triggers: string[];
  plan: {
    entry: number;
    stopLoss: number;
    takeProfit: number;
    takeProfit2: number;
    riskPips: number;
    swingEntry?: number;
    swingStopLoss?: number;
    swingRiskPips?: number;
  } | null;
}

const Zone = ({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  icon: React.ElementType;
  tone?: "bull" | "bear" | "neutral";
}) => (
  <div className="flex flex-col gap-0.5">
    <div className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-muted-foreground">
      <Icon className="h-2.5 w-2.5" />
      {label}
    </div>
    <div
      className={cn(
        "font-mono text-xs font-semibold tabular-nums",
        tone === "bull" && "text-bull",
        tone === "bear" && "text-bear",
      )}
    >
      {value}
    </div>
  </div>
);

export const DevelopingSetupCard = ({
  setup,
  index,
}: {
  setup: DevelopingSetup;
  index: number;
}) => {
  const isBuy = setup.direction === "BUY";
  const plan = setup.plan;

  // LTF is the live trigger; swing is optional context only
  const entry = plan?.entry;
  const stop = plan?.stopLoss;
  const tp1 = plan?.takeProfit;
  const tp2 = plan?.takeProfit2;
  const riskPips = plan?.riskPips;

  return (
    <div
      className={cn(
        "fade-in-up relative overflow-hidden rounded-lg border surface-1 p-4 transition-smooth hover:-translate-y-0.5",
        setup.newsMomentum ? "border-gold/40 shadow-gold/20" : "border-border/60",
      )}
      style={{ animationDelay: `${index * 50}ms` }}
    >
      {setup.newsMomentum && (
        <div className="absolute right-3 top-3 flex items-center gap-1 rounded-md bg-gold/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-gold">
          <Zap className="h-2.5 w-2.5" />
          News
        </div>
      )}

      <div className="flex items-center gap-2">
        <h3 className="font-mono text-base font-bold tracking-tight">{setup.pair}</h3>
        <span
          className={cn(
            "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase",
            isBuy ? "bg-bull/10 text-bull" : "bg-bear/10 text-bear",
          )}
        >
          {isBuy ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
          {setup.direction}
        </span>
        <span className="rounded border border-border/50 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
          LTF trigger
        </span>
      </div>

      <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{setup.reason}</p>

      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between text-[9px] uppercase tracking-wider text-muted-foreground">
          <span className="flex items-center gap-1">
            <Clock className="h-2.5 w-2.5" />
            Proximity
          </span>
          <span className="font-mono tabular-nums text-foreground/70">{setup.proximity}%</span>
        </div>
        <div className="h-1 overflow-hidden rounded-full surface-3">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              setup.proximity >= 70
                ? "bg-gold"
                : setup.proximity >= 40
                  ? "bg-primary/60"
                  : "bg-muted-foreground/40",
            )}
            style={{ width: `${Math.min(100, setup.proximity)}%` }}
          />
        </div>
      </div>

      {plan && entry != null && stop != null && (
        <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg surface-2 p-2.5">
          <Zone label="LTF entry" value={String(entry)} icon={Activity} tone={isBuy ? "bull" : "bear"} />
          <Zone label="Stop" value={String(stop)} icon={Shield} tone="bear" />
          {tp1 != null && <Zone label="TP1" value={String(tp1)} icon={Target} tone="bull" />}
          {tp2 != null && <Zone label="TP2" value={String(tp2)} icon={Target} tone="bull" />}
        </div>
      )}

      {plan?.swingEntry != null && (
        <p className="mt-2 text-[10px] text-muted-foreground">
          Deeper swing ref{" "}
          <span className="font-mono text-foreground/80">{plan.swingEntry}</span>
          {plan.swingStopLoss != null && (
            <>
              {" · "}SL{" "}
              <span className="font-mono text-foreground/80">{plan.swingStopLoss}</span>
            </>
          )}
          {" "}(context only — not the live trigger)
        </p>
      )}

      <ul className="mt-3 space-y-1">
        {setup.triggers.map((t, i) => (
          <li
            key={i}
            className={cn(
              "text-[11px] leading-tight",
              t.startsWith("✓") && "text-foreground/85",
              t.startsWith("◌") && "text-muted-foreground",
              t.startsWith("⚡") && "text-gold",
              t.startsWith("⚠") && "text-bear",
            )}
          >
            {t}
          </li>
        ))}
      </ul>

      <div className="mt-3 flex items-center justify-between border-t border-border/40 pt-2 text-[10px] text-muted-foreground">
        <span>
          Bias: <span className="text-foreground/80">{setup.htf_bias}</span>
          {riskPips != null && (
            <>
              {" · "}Risk:{" "}
              <span className="font-mono text-foreground/80">{riskPips}p</span>
            </>
          )}
        </span>
        <span className="font-mono">@ {setup.currentPrice}</span>
      </div>
    </div>
  );
};
