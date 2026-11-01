import { ArrowDown, ArrowUp, Target, Shield, TrendingUp, Activity, Check, X, ChevronDown, Copy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { RiskCalculator } from "./RiskCalculator";
import { TradeActionBanner, approachAlertPrice, type ActionMode } from "@/components/TradeActionBanner";

export interface ConfidenceFactor {
  label: string;
  points: number;
  hit: boolean;
}

export interface Signal {
  pair: string;
  direction: "BUY" | "SELL";
  entry: number;
  stopLoss: number;
  takeProfit: number;        // TP1 (3R)
  takeProfit2?: number;      // TP2 (8R)
  riskReward: number;
  confidence: number;
  structure: "BOS" | "CHoCH";
  confluences: string[];
  confidenceBreakdown?: ConfidenceFactor[];
  currentPrice: number;
  timestamp: string;
  htf_bias: "Bullish" | "Bearish" | "Neutral";
  swingEntry?: number;
  swingStopLoss?: number;
  swingRiskPips?: number;
  splitEntry?: {
    tier1: number;
    tier2: number;
    allocation: number;
    blendedEntry: number;
    blendedRiskPips: number;
  };
  ltfConfirmed?: boolean;
  awaitingLtfConfirmation?: boolean;
  autoTrigger?: boolean;
  entryModel?: "OTE" | "FVG" | "Breaker" | "Judas" | "OB";
  entryTrigger?: "MARKET_ON_CONFIRMATION" | "LIMIT";
  entryZone?: { top: number; bottom: number };
  signalStyle?: "swing" | "scalp";
  structureTimeframe?: string;
  entryTimeframe?: string;
  setupGrade?: "A+" | "B";
}


const ConfidenceBar = ({ value }: { value: number }) => {
  const color =
    value >= 75 ? "gradient-bull" : value >= 55 ? "gradient-gold" : "gradient-bear";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full surface-3">
        <div
          className={cn("h-full rounded-full transition-all", color)}
          style={{ width: `${value}%` }}
        />
      </div>
      <span className="text-xs font-mono tabular-nums text-muted-foreground w-9 text-right">
        {value}%
      </span>
    </div>
  );
};

const Stat = ({
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
  <div className="flex flex-col gap-1">
    <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
      <Icon className="h-3 w-3" />
      {label}
    </div>
    <div
      className={cn(
        "font-mono text-sm font-semibold tabular-nums",
        tone === "bull" && "text-bull",
        tone === "bear" && "text-bear"
      )}
    >
      {value}
    </div>
  </div>
);

export const SignalCard = ({ signal, index }: { signal: Signal; index: number }) => {
  const isBuy = signal.direction === "BUY";
  const [showBreakdown, setShowBreakdown] = useState(false);
  const breakdown = signal.confidenceBreakdown ?? [];
  const totalPossible = breakdown.reduce((s, f) => s + f.points, 0);
  const earned = breakdown.filter((f) => f.hit).reduce((s, f) => s + f.points, 0);
  const isScalp = signal.signalStyle === "scalp";
  return (
    <div
      className={cn(
        "fade-in-up group relative overflow-hidden rounded-lg border border-border/70 surface-1 p-5 shadow-card transition-smooth hover:-translate-y-0.5",
        isScalp
          ? "border-primary/40 ring-1 ring-primary/15"
          : isBuy
            ? "card-rail-bull border-bull/25 hover:shadow-bull"
            : "card-rail-bear border-bear/25 hover:shadow-bear"
      )}
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div
        className={cn(
          "absolute inset-x-0 top-0 h-0.5",
          isScalp ? "bg-[hsl(var(--gold))]" : isBuy ? "gradient-bull" : "gradient-bear"
        )}
      />

      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-mono text-lg font-bold tracking-tight">{signal.pair}</h3>
            <Badge
              variant="outline"
              className="h-5 border-border/60 bg-secondary text-[10px] font-medium"
            >
              {signal.structure}
            </Badge>
            {signal.signalStyle === "scalp" ? (
              <Badge className="h-5 bg-gold/20 text-gold border-gold/40 text-[10px] font-bold uppercase">
                Scalp
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="h-5 border-border/60 bg-secondary text-[10px] font-medium uppercase"
              >
                Swing
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            HTF bias: <span className="text-foreground/80">{signal.htf_bias}</span>
            {signal.structureTimeframe && signal.entryTimeframe && (
              <>
                {" · "}
                <span className="text-foreground/80">
                  {signal.structureTimeframe} structure → {signal.entryTimeframe} entry
                </span>
              </>
            )}
          </p>
        </div>

        <div
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-bold tracking-wide",
            isBuy ? "bg-bull/10 text-bull" : "bg-bear/10 text-bear"
          )}
        >
          {isBuy ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />}
          {signal.direction}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {signal.setupGrade && (
          <span
            className={cn(
              "inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
              signal.setupGrade === "A+"
                ? "border-bull/40 bg-bull/10 text-bull"
                : "border-border bg-muted/40 text-muted-foreground",
            )}
          >
            Grade {signal.setupGrade}
            {signal.setupGrade === "A+" ? " · auto-book" : " · watch"}
          </span>
        )}
        {signal.entryModel && (
          <div className="inline-flex items-center gap-1.5 rounded-md border border-gold/40 bg-gold/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-gold">
            <Activity className="h-3 w-3" />
            {signal.entryModel === "OTE" && "OTE · 61.8–79% fib"}
            {signal.entryModel === "FVG" && "FVG mitigation"}
            {signal.entryModel === "Breaker" && "Breaker block flip"}
            {signal.entryModel === "Judas" && "Judas sweep + CHoCH"}
            {signal.entryModel === "OB" && "Order block · 50% mean"}
            <span className="text-muted-foreground font-medium normal-case tracking-normal">
              · on {signal.entryTimeframe ?? "LTF"} confirm
            </span>
          </div>
        )}
      </div>

      </div>

      <TradeActionBanner
        mode={((): ActionMode => {
          if (signal.autoTrigger || (signal.setupGrade === "A+" && signal.confidence >= 90)) {
            return "auto_fire";
          }
          if (signal.setupGrade === "B") return "watch_only";
          if (signal.entryTrigger === "LIMIT") return "arm_limit";
          if (signal.awaitingLtfConfirmation) return "wait_confirm";
          // Default for active A+ / confirmed signals: wait for entry-TF confirmation
          if (signal.entryTrigger === "MARKET_ON_CONFIRMATION" || signal.ltfConfirmed === false) {
            return "wait_confirm";
          }
          if (signal.setupGrade === "A+") return "arm_limit";
          return "wait_confirm";
        })()}
        pair={signal.pair}
        direction={signal.direction}
        alertPrice={approachAlertPrice(signal.direction, signal.entry, signal.currentPrice)}
        limitPrice={signal.entry}
        stopLoss={signal.stopLoss}
        takeProfit={signal.takeProfit}
        entryTimeframe={signal.entryTimeframe}
      />

      <div className="mt-4">
        <ConfidenceBar value={signal.confidence} />
        {breakdown.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setShowBreakdown((s) => !s)}
              className="mt-2 flex w-full items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-smooth"
            >
              <span>
                Confidence breakdown · {earned}/{totalPossible} pts
              </span>
              <ChevronDown
                className={cn(
                  "h-3 w-3 transition-transform",
                  showBreakdown && "rotate-180"
                )}
              />
            </button>
            {showBreakdown && (
              <ul className="mt-2 space-y-1 rounded-lg surface-2 p-2.5">
                {breakdown.map((f, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between gap-2 text-[11px]"
                  >
                    <span className="flex items-center gap-1.5">
                      {f.hit ? (
                        <Check className="h-3 w-3 text-bull" />
                      ) : (
                        <X className="h-3 w-3 text-muted-foreground/40" />
                      )}
                      <span
                        className={cn(
                          f.hit ? "text-foreground/85" : "text-muted-foreground/60"
                        )}
                      >
                        {f.label}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "font-mono tabular-nums",
                        f.hit ? "text-bull" : "text-muted-foreground/40"
                      )}
                    >
                      {f.hit ? "+" : ""}
                      {f.points}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 rounded-lg surface-2 p-3">
        <Stat label="Entry" value={String(signal.entry)} icon={Activity} />
        <Stat label="Stop" value={String(signal.stopLoss)} icon={Shield} tone="bear" />
        <Stat
          label={`TP1 (${(Math.abs(signal.takeProfit - signal.entry) / Math.abs(signal.entry - signal.stopLoss)).toFixed(1)}R)`}
          value={String(signal.takeProfit)}
          icon={Target}
          tone="bull"
        />
        {signal.takeProfit2 != null ? (
          <Stat
            label={`TP2 (${(Math.abs(signal.takeProfit2 - signal.entry) / Math.abs(signal.entry - signal.stopLoss)).toFixed(1)}R)`}
            value={String(signal.takeProfit2)}
            icon={Target}
            tone="bull"
          />
        ) : (
          <Stat label="Target" value={String(signal.takeProfit)} icon={Target} tone="bull" />
        )}
      </div>

      {signal.swingEntry != null && (
        <div className="mt-3 grid grid-cols-2 gap-3 rounded-lg border border-gold/40 bg-gold/5 p-3">
          <Stat
            label="Swing entry"
            value={String(signal.swingEntry)}
            icon={Target}
            tone={isBuy ? "bull" : "bear"}
          />
          <Stat
            label="Swing stop"
            value={String(signal.swingStopLoss)}
            icon={Shield}
            tone="bear"
          />
          <div className="col-span-2 text-[10px] text-muted-foreground">
            Deeper HTF discount/premium fill · Risk{" "}
            <span className="font-mono text-foreground/80">
              {signal.swingRiskPips}p
            </span>
            {" · "}Same TP1/TP2 targets
          </div>
        </div>
      )}

      {/* Split-entry smoothing block — scale in 50/50 across LTF + swing tiers */}
      {signal.splitEntry && (
        <div className="mt-3 rounded-lg border border-bull/30 bg-bull/5 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase tracking-wider text-foreground">
              Split entry · 50/50 scale-in
            </span>
            {signal.autoTrigger ? (
              <span className="rounded-md bg-bull/25 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-bull animate-pulse">
                ⚡ Auto-fire · 95%+
              </span>
            ) : signal.awaitingLtfConfirmation ? (
              <span className="rounded-md bg-gold/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-gold">
                Awaiting 1H CHoCH
              </span>
            ) : (
              <span className="rounded-md bg-bull/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-bull">
                LTF confirmed
              </span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2 text-[11px]">
            <div className="flex flex-col">
              <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
                Tier 1 · 50%
              </span>
              <span className="font-mono font-semibold tabular-nums">
                {signal.splitEntry.tier1}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
                Tier 2 · 50%
              </span>
              <span className="font-mono font-semibold tabular-nums">
                {signal.splitEntry.tier2}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
                Blended
              </span>
              <span className="font-mono font-semibold tabular-nums text-gold">
                {signal.splitEntry.blendedEntry}
              </span>
            </div>
          </div>
          <div className="mt-2 text-[10px] text-muted-foreground">
            If both fill, effective risk{" "}
            <span className="font-mono text-foreground/80">
              {signal.splitEntry.blendedRiskPips}p
            </span>
            {signal.autoTrigger
              ? " · 95%+ conviction — fire both limits immediately"
              : signal.awaitingLtfConfirmation
              ? " · Arm limits only after 1H structure shift in trade direction"
              : " · LTF structure shift in place — limits armed"}
          </div>
        </div>
      )}




      <RiskCalculator
        pair={signal.pair}
        direction={signal.direction}
        entry={signal.entry}
        stopLoss={signal.stopLoss}
        takeProfit={signal.takeProfit}
        takeProfit2={signal.takeProfit2}
      />

      <CopyMtBlock signal={signal} />

      <div className="mt-3 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          Max R:R{" "}
          <span className="font-mono font-semibold text-foreground">
            1:{signal.riskReward}
          </span>
        </span>
        <span className="text-muted-foreground">
          Price{" "}
          <span className="font-mono font-semibold text-foreground">
            {signal.currentPrice}
          </span>
        </span>
      </div>

      <div className="mt-4 border-t border-border/50 pt-3">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
          <TrendingUp className="h-3 w-3" />
          Confluences
        </div>
        <ul className="mt-2 space-y-1">
          {signal.confluences.map((c, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-foreground/80">
              <span
                className={cn(
                  "mt-1.5 h-1 w-1 flex-shrink-0 rounded-full",
                  c.startsWith("⚠") ? "bg-bear" : "bg-gold"
                )}
              />
              <span>{c.replace(/^⚠\s*/, "")}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

/**
 * MetaTrader-friendly order ticket. Renders the order parameters in a
 * monospaced block and offers one-tap copy buttons for the full ticket and
 * for individual numeric fields (handy on mobile where MT4/5 inputs accept
 * paste but not drag-select).
 */
const CopyMtBlock = ({ signal }: { signal: Signal }) => {
  const symbol = signal.pair.replace("/", "");
  const isMarket = signal.entryTrigger === "MARKET_ON_CONFIRMATION";
  const orderType = isMarket
    ? (signal.direction === "BUY" ? "BUY (MARKET)" : "SELL (MARKET)")
    : (signal.direction === "BUY" ? "BUY LIMIT" : "SELL LIMIT");
  const isBuy = signal.direction === "BUY";

  const hasSplit = !!signal.splitEntry;
  const tier1Price = hasSplit ? signal.splitEntry!.tier1 : signal.entry;
  const tier2Price = hasSplit ? signal.splitEntry!.tier2 : null;
  const ticket = hasSplit
    ? [
        `Symbol: ${symbol}`,
        `Type: ${orderType}`,
        `-- 50% @ Tier 1 (LTF) --`,
        `Entry: ${tier1Price}`,
        `SL: ${signal.stopLoss}`,
        `TP1: ${signal.takeProfit}`,
        signal.takeProfit2 != null ? `TP2: ${signal.takeProfit2}` : null,
        `-- 50% @ Tier 2 (Swing) --`,
        `Entry: ${tier2Price}`,
        `SL: ${signal.swingStopLoss}`,
        `TP1: ${signal.takeProfit}`,
        signal.takeProfit2 != null ? `TP2: ${signal.takeProfit2}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    : [
        `Symbol: ${symbol}`,
        `Type: ${orderType}`,
        `Entry: ${signal.entry}`,
        `SL: ${signal.stopLoss}`,
        `TP1: ${signal.takeProfit}`,
        signal.takeProfit2 != null ? `TP2: ${signal.takeProfit2}` : null,
      ]
        .filter(Boolean)
        .join("\n");

  const copy = async (value: string | number, label: string) => {
    try {
      await navigator.clipboard.writeText(String(value));
      toast.success(`${label} copied`, { duration: 1500 });
    } catch {
      toast.error("Copy failed");
    }
  };

  return (
    <div
      className={cn(
        "mt-4 rounded-lg border-l-4 p-3 sm:p-4",
        isBuy
          ? "border-l-bull bg-bull/5"
          : "border-l-bear bg-bear/5"
      )}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Copy className="h-4 w-4 text-muted-foreground" />
          <span className="text-xs font-bold uppercase tracking-wider text-foreground">
            MetaTrader Order
          </span>
        </div>
        <Button
          size="sm"
          className="h-8 gap-1.5 px-4 text-xs font-bold gradient-gold text-primary-foreground shadow-gold hover:opacity-90"
          onClick={() => copy(ticket, "Order ticket")}
        >
          <Copy className="h-3.5 w-3.5" /> Copy all
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px] sm:text-xs">
        <CopyField label="Symbol" value={symbol} onCopy={copy} />
        <CopyField label="Type" value={orderType} onCopy={copy} />
        {hasSplit ? (
          <>
            <CopyField label="T1 Entry (50%)" value={tier1Price} onCopy={copy} />
            <CopyField label="T1 SL" value={signal.stopLoss} onCopy={copy} />
            <CopyField label="T2 Entry (50%)" value={tier2Price!} onCopy={copy} />
            <CopyField label="T2 SL" value={signal.swingStopLoss!} onCopy={copy} />
          </>
        ) : (
          <>
            <CopyField label="Entry" value={signal.entry} onCopy={copy} />
            <CopyField label="SL" value={signal.stopLoss} onCopy={copy} />
          </>
        )}
        <CopyField label="TP1" value={signal.takeProfit} onCopy={copy} />
        {signal.takeProfit2 != null && (
          <CopyField label="TP2" value={signal.takeProfit2} onCopy={copy} />
        )}
      </div>
    </div>
  );
};

const CopyField = ({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string | number;
  onCopy: (v: string | number, label: string) => void;
}) => (
  <button
    type="button"
    onClick={() => onCopy(value, label)}
    className="flex items-center justify-between gap-2 rounded-md surface-3 px-2 py-1.5 text-left transition-smooth hover:bg-foreground/5"
  >
    <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
      {label}
    </span>
    <span className="flex items-center gap-1 font-mono tabular-nums text-foreground">
      {value}
      <Copy className="h-2.5 w-2.5 text-muted-foreground" />
    </span>
  </button>
);
