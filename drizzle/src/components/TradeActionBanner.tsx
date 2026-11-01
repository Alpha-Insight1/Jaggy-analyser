import { Bell, Crosshair, ShieldAlert, Zap, Copy, Check, Clock } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export type ActionMode =
  | "alert_only"       // Developing — no order yet
  | "wait_confirm"     // Active signal, market on confirmation
  | "arm_limit"        // Active signal, place limit in zone
  | "auto_fire"        // A+ high conviction — ready now
  | "watch_only";      // B-grade or weak — do not size fully

interface Props {
  mode: ActionMode;
  pair: string;
  direction: "BUY" | "SELL";
  /** Price to put on a platform alert (approach zone) */
  alertPrice?: number | null;
  /** Suggested limit price */
  limitPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  entryTimeframe?: string;
  className?: string;
}

const copyText = async (value: string, label: string) => {
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  } catch {
    toast.error("Could not copy");
  }
};

const MODE_META: Record<
  ActionMode,
  {
    label: string;
    hint: string;
    icon: typeof Bell;
    tone: "neutral" | "gold" | "bull" | "bear" | "warn";
  }
> = {
  alert_only: {
    label: "Alert only",
    hint: "Developing setup — do not enter yet. Set a price alert near the zone and wait for confirmation.",
    icon: Bell,
    tone: "gold",
  },
  wait_confirm: {
    label: "Wait for confirmation",
    hint: "Armed. Wait for the entry-TF candle to close inside the zone in trade direction, then enter at market.",
    icon: Clock,
    tone: "bull",
  },
  arm_limit: {
    label: "Arm limit",
    hint: "Place a limit inside the zone (prefer mean / OTE / FVG). Cancel if structure fails or session ends.",
    icon: Crosshair,
    tone: "bull",
  },
  auto_fire: {
    label: "Ready · A+",
    hint: "High-conviction A+ setup. You may enter on the signal plan now if session and risk rules allow.",
    icon: Zap,
    tone: "bull",
  },
  watch_only: {
    label: "Watch only",
    hint: "B-grade / incomplete. Do not auto-size. Alert only unless you take reduced discretionary risk.",
    icon: ShieldAlert,
    tone: "warn",
  },
};

export function TradeActionBanner({
  mode,
  pair,
  direction,
  alertPrice,
  limitPrice,
  stopLoss,
  takeProfit,
  entryTimeframe,
  className,
}: Props) {
  const meta = MODE_META[mode];
  const Icon = meta.icon;
  const [copied, setCopied] = useState<string | null>(null);

  const onCopy = async (value: string | number | null | undefined, key: string, label: string) => {
    if (value == null) return;
    await copyText(String(value), label);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  const toneCls =
    meta.tone === "gold"
      ? "border-primary/30 bg-primary/5"
      : meta.tone === "bull"
        ? "border-bull/30 bg-bull/5"
        : meta.tone === "warn"
          ? "border-border/70 bg-muted/30"
          : "border-border/60 bg-muted/20";

  const badgeCls =
    meta.tone === "gold"
      ? "bg-primary/15 text-primary border-primary/30"
      : meta.tone === "bull"
        ? "bg-bull/15 text-bull border-bull/30"
        : meta.tone === "warn"
          ? "bg-muted text-muted-foreground border-border"
          : "bg-secondary text-foreground border-border";

  return (
    <div className={cn("mt-3 rounded-lg border p-3", toneCls, className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                badgeCls,
              )}
            >
              <Icon className="h-3 w-3" />
              {meta.label}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {pair} · {direction}
              {entryTimeframe ? ` · ${entryTimeframe}` : ""}
            </span>
          </div>
          <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{meta.hint}</p>
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {alertPrice != null && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 gap-1.5 px-2.5 text-[11px]"
            onClick={() => onCopy(alertPrice, "alert", "Alert price")}
          >
            {copied === "alert" ? <Check className="h-3 w-3" /> : <Bell className="h-3 w-3" />}
            Alert @ {alertPrice}
          </Button>
        )}
        {(mode === "arm_limit" || mode === "auto_fire") && limitPrice != null && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 gap-1.5 px-2.5 text-[11px]"
            onClick={() => onCopy(limitPrice, "limit", "Limit price")}
          >
            {copied === "limit" ? <Check className="h-3 w-3" /> : <Crosshair className="h-3 w-3" />}
            Limit @ {limitPrice}
          </Button>
        )}
        {stopLoss != null && mode !== "alert_only" && mode !== "watch_only" && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground"
            onClick={() => onCopy(stopLoss, "sl", "Stop loss")}
          >
            {copied === "sl" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            SL {stopLoss}
          </Button>
        )}
        {takeProfit != null && mode !== "alert_only" && mode !== "watch_only" && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground"
            onClick={() => onCopy(takeProfit, "tp", "Take profit")}
          >
            {copied === "tp" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            TP {takeProfit}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Derive approach alert price slightly before entry zone. */
export function approachAlertPrice(
  direction: "BUY" | "SELL",
  entry: number,
  currentPrice: number,
  fraction = 0.15,
): number {
  // Alert when price has moved most of the way toward entry
  const dist = entry - currentPrice;
  const alert = currentPrice + dist * (1 - fraction);
  // sensible decimals
  const abs = Math.abs(entry);
  const decimals = abs >= 100 ? 1 : abs >= 10 ? 2 : abs >= 1 ? 4 : 5;
  return Number(alert.toFixed(decimals));
}
