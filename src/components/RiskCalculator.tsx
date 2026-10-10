import { useEffect, useMemo, useState } from "react";
import { Calculator, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface RiskCalculatorProps {
  pair: string;
  direction: "BUY" | "SELL";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  takeProfit2?: number;
}

/** Pip size per instrument family. */
function pipSize(pair: string): number {
  const p = pair.toUpperCase();
  if (p.includes("JPY")) return 0.01;
  if (p.startsWith("BTC") || p.startsWith("ETH")) return 1;
  if (p.startsWith("GER") || p.startsWith("US") || p.startsWith("NAS") || p.startsWith("SPX")) return 1;
  if (p.startsWith("XAU")) return 0.1; // gold
  return 0.0001;
}

const STORAGE_KEY = "risk-calc-prefs";

export const RiskCalculator = ({
  pair,
  direction,
  entry,
  stopLoss,
  takeProfit,
  takeProfit2,
}: RiskCalculatorProps) => {
  const [open, setOpen] = useState(false);

  // Persist account size + risk % so the user doesn't retype on every card.
  const [balance, setBalance] = useState<number>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
      return typeof v.balance === "number" ? v.balance : 10000;
    } catch {
      return 10000;
    }
  });
  const [riskPct, setRiskPct] = useState<number>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
      return typeof v.riskPct === "number" ? v.riskPct : 1;
    } catch {
      return 1;
    }
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ balance, riskPct }));
  }, [balance, riskPct]);

  const calc = useMemo(() => {
    const pip = pipSize(pair);
    const stopDistRaw = Math.abs(entry - stopLoss);
    const tp1DistRaw = Math.abs(takeProfit - entry);
    const tp2DistRaw = takeProfit2 != null ? Math.abs(takeProfit2 - entry) : null;

    const stopPips = stopDistRaw / pip;
    const tp1Pips = tp1DistRaw / pip;
    const tp2Pips = tp2DistRaw != null ? tp2DistRaw / pip : null;

    const r1 = stopDistRaw ? tp1DistRaw / stopDistRaw : 0;
    const r2 = stopDistRaw && tp2DistRaw != null ? tp2DistRaw / stopDistRaw : null;

    const riskUsd = (balance * riskPct) / 100;
    // Position size is reported as "$ per pip" — broker-agnostic, works for FX,
    // indices, metals and crypto without needing tick-value tables.
    const perPip = stopPips > 0 ? riskUsd / stopPips : 0;
    const tp1Usd = perPip * (tp1Pips ?? 0);
    const tp2Usd = tp2Pips != null ? perPip * tp2Pips : null;

    const decimals = pip < 0.01 ? 5 : pip < 1 ? 3 : 2;

    return {
      stopPips,
      tp1Pips,
      tp2Pips,
      r1,
      r2,
      riskUsd,
      perPip,
      tp1Usd,
      tp2Usd,
      stopDist: stopDistRaw.toFixed(decimals),
      tp1Dist: tp1DistRaw.toFixed(decimals),
      tp2Dist: tp2DistRaw != null ? tp2DistRaw.toFixed(decimals) : null,
      direction,
    };
  }, [pair, entry, stopLoss, takeProfit, takeProfit2, balance, riskPct, direction]);

  return (
    <div className="mt-3 rounded-lg border border-border/60 surface-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground transition-smooth hover:text-foreground"
      >
        <span className="flex items-center gap-1.5">
          <Calculator className="h-3 w-3" />
          Risk Calculator · {calc.stopPips.toFixed(1)} pips · {calc.r1.toFixed(2)}R / {calc.r2 != null ? calc.r2.toFixed(2) + "R" : "—"}
        </span>
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="space-y-3 border-t border-border/60 px-3 py-3">
          {/* Inputs */}
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Account ($)
              </span>
              <input
                type="number"
                inputMode="decimal"
                min={0}
                value={balance}
                onChange={(e) => setBalance(Number(e.target.value) || 0)}
                className="rounded-md surface-3 px-2 py-1 font-mono text-sm tabular-nums outline-none ring-0 focus:ring-2 focus:ring-primary/40"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Risk %
              </span>
              <input
                type="number"
                inputMode="decimal"
                step="0.1"
                min={0}
                max={100}
                value={riskPct}
                onChange={(e) => setRiskPct(Number(e.target.value) || 0)}
                className="rounded-md surface-3 px-2 py-1 font-mono text-sm tabular-nums outline-none ring-0 focus:ring-2 focus:ring-primary/40"
              />
            </label>
          </div>

          {/* Distance / pips */}
          <div className="grid grid-cols-3 gap-2 rounded-md surface-3 p-2 text-center">
            <Cell label="Stop" pips={calc.stopPips} dist={calc.stopDist} tone="bear" />
            <Cell label="TP1" pips={calc.tp1Pips} dist={calc.tp1Dist} tone="bull" extra={`${calc.r1.toFixed(2)}R`} />
            <Cell
              label="TP2"
              pips={calc.tp2Pips}
              dist={calc.tp2Dist}
              tone="bull"
              extra={calc.r2 != null ? `${calc.r2.toFixed(2)}R` : "—"}
            />
          </div>

          {/* P/L preview */}
          <div className="grid grid-cols-3 gap-2 text-[11px]">
            <Money label="Risk" value={calc.riskUsd} tone="bear" />
            <Money label="TP1 win" value={calc.tp1Usd} tone="bull" />
            <Money label="TP2 win" value={calc.tp2Usd} tone="bull" />
          </div>

          <p className="text-[10px] leading-relaxed text-muted-foreground">
            Position size: <span className="font-mono text-foreground">${calc.perPip.toFixed(2)}</span> per pip ·
            place {direction.toLowerCase()} stop at <span className="font-mono text-foreground">{stopLoss}</span>.
          </p>
        </div>
      )}
    </div>
  );
};

const Cell = ({
  label,
  pips,
  dist,
  tone,
  extra,
}: {
  label: string;
  pips: number | null;
  dist: string | null;
  tone: "bull" | "bear";
  extra?: string;
}) => (
  <div className="flex flex-col">
    <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</span>
    <span
      className={cn(
        "font-mono text-sm font-semibold tabular-nums",
        tone === "bull" ? "text-bull" : "text-bear",
      )}
    >
      {pips != null ? `${pips.toFixed(1)}p` : "—"}
    </span>
    <span className="font-mono text-[10px] text-muted-foreground">{dist ?? "—"}</span>
    {extra && <span className="font-mono text-[10px] text-foreground/70">{extra}</span>}
  </div>
);

const Money = ({ label, value, tone }: { label: string; value: number | null; tone: "bull" | "bear" }) => (
  <div className="flex flex-col rounded-md surface-3 p-2">
    <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</span>
    <span
      className={cn(
        "font-mono text-sm font-semibold tabular-nums",
        tone === "bull" ? "text-bull" : "text-bear",
      )}
    >
      {value == null
        ? "—"
        : `${tone === "bear" ? "-" : "+"}$${Math.abs(value).toFixed(2)}`}
    </span>
  </div>
);
