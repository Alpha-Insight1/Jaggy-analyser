import { ArrowDown, ArrowUp, Zap, Clock, Activity, Shield, Target } from "lucide-react";
import { cn } from "@/lib/utils";
import { TradeActionBanner, approachAlertPrice } from "@/components/TradeActionBanner";

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
        tone === "bear" && "text-bear"
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
  return (
    <div
      className={cn(
        "fade-in-up relative overflow-hidden rounded-lg border surface-1 p-4 transition-smooth hover:-translate-y-0.5",
        setup.newsMomentum ? "border-gold/40 shadow-gold/20" : "border-border/60"
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
            isBuy ? "bg-bull/10 text-bull" : "bg-bear/10 text-bear"
          )}
        >
          {isBuy ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
          {setup.direction}
        </span>
      </div>

      <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="h-3 w-3" />
        {setup.reason}
      </p>

      <div className="mt-3 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full surface-3">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              setup.proximity >= 70 ? "gradient-gold" : "gradient-bull"
            )}
            style={{ width: `${setup.proximity}%` }}
          />
        </div>
        <span className="w-9 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
          {setup.proximity}%
        </span>
      </div>

      <TradeActionBanner
        mode="alert_only"
        pair={setup.pair}
        direction={setup.direction}
        alertPrice={
          setup.plan
            ? approachAlertPrice(setup.direction, setup.plan.entry, setup.currentPrice)
            : setup.currentPrice
        }
        limitPrice={setup.plan?.entry ?? null}
        stopLoss={setup.plan?.stopLoss ?? null}
        takeProfit={setup.plan?.takeProfit ?? null}
      />

      {/* Proposed trade zones */}
      {setup.plan && (
        <div className="mt-3 space-y-2">
          <div className="grid grid-cols-2 gap-2 rounded-lg surface-2 p-2.5">
            <Zone label="LTF entry" value={String(setup.plan.entry)} icon={Activity} />
            <Zone label="Stop" value={String(setup.plan.stopLoss)} icon={Shield} tone="bear" />
            <Zone label="TP1 (swing)" value={String(setup.plan.takeProfit)} icon={Target} tone="bull" />
            <Zone label="TP2 (HTF)" value={String(setup.plan.takeProfit2)} icon={Target} tone="bull" />
          </div>
          {setup.plan.swingEntry != null && (
            <div className="grid grid-cols-2 gap-2 rounded-lg border border-gold/30 bg-gold/5 p-2.5">
              <Zone
                label="Swing entry"
                value={String(setup.plan.swingEntry)}
                icon={Target}
                tone={isBuy ? "bull" : "bear"}
              />
              <Zone
                label="Swing stop"
                value={String(setup.plan.swingStopLoss)}
                icon={Shield}
                tone="bear"
              />
              <div className="col-span-2 text-[10px] text-muted-foreground">
                Deeper HTF discount/premium fill · Risk{" "}
                <span className="font-mono text-foreground/80">
                  {setup.plan.swingRiskPips}p
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      <ul className="mt-3 space-y-1">
        {setup.triggers.map((t, i) => (
          <li
            key={i}
            className={cn(
              "text-[11px] leading-tight",
              t.startsWith("✓") && "text-foreground/85",
              t.startsWith("◌") && "text-muted-foreground",
              t.startsWith("⚡") && "text-gold"
            )}
          >
            {t}
          </li>
        ))}
      </ul>

      <div className="mt-3 flex items-center justify-between border-t border-border/40 pt-2 text-[10px] text-muted-foreground">
        <span>
          Bias: <span className="text-foreground/80">{setup.htf_bias}</span>
          {setup.plan && (
            <>
              {" · "}Risk:{" "}
              <span className="font-mono text-foreground/80">{setup.plan.riskPips}p</span>
            </>
          )}
        </span>
        <span className="font-mono">@ {setup.currentPrice}</span>
      </div>
    </div>
  );
};
