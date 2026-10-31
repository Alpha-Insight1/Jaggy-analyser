import { useEffect, useState } from "react";
import { Clock, CheckCircle2, PauseCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Mirrors the edge-function session gates:
 *  - Weekend gap block: Friday 19:00 UTC → Sunday 22:00 UTC (FX + indices)
 *  - Spread rollover block: daily 20:00 → 22:00 UTC
 */
type Status = {
  blocked: boolean;
  reason: string;
  detail: string;
  resumesAt: Date | null;
};

function nextUtc(day: number, hour: number, from: Date): Date {
  const d = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hour, 0, 0, 0),
  );
  while (d.getUTCDay() !== day || d.getTime() <= from.getTime()) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

export function getMarketStatus(now = new Date()): Status {
  const day = now.getUTCDay(); // 0 Sun … 6 Sat
  const hour = now.getUTCHours();

  const weekendBlocked =
    (day === 5 && hour >= 19) || day === 6 || (day === 0 && hour < 22);

  if (weekendBlocked) {
    return {
      blocked: true,
      reason: "Weekend — markets closed",
      detail:
        "New entries are blocked from Friday 19:00 UTC to Sunday 22:00 UTC to avoid weekend gap risk.",
      resumesAt: nextUtc(0, 22, now),
    };
  }

  if (hour >= 20 && hour < 22) {
    const resume = new Date(now);
    resume.setUTCHours(22, 0, 0, 0);
    return {
      blocked: true,
      reason: "Daily rollover — spreads widened",
      detail: "Entries pause between 20:00 and 22:00 UTC while liquidity thins and spreads spike.",
      resumesAt: resume,
    };
  }

  return {
    blocked: false,
    reason: "Markets open — scanning live",
    detail: "All 34 instruments are being scanned for fresh order-block setups.",
    resumesAt: null,
  };
}

function fmtCountdown(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export const MarketStatusBanner = () => {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const status = getMarketStatus(now);
  const Icon = status.blocked ? PauseCircle : CheckCircle2;

  return (
    <div
      className={cn(
        "mb-6 flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between",
        status.blocked
          ? "border-gold/30 bg-gold/5"
          : "border-bull/30 bg-bull/5",
      )}
    >
      <div className="flex items-start gap-3">
        <Icon
          className={cn("mt-0.5 h-5 w-5 flex-shrink-0", status.blocked ? "text-gold" : "text-bull")}
        />
        <div>
          <p className="text-sm font-semibold">{status.reason}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{status.detail}</p>
        </div>
      </div>

      {status.resumesAt && (
        <div className="flex items-center gap-3 rounded-lg surface-2 px-3 py-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <div className="text-right">
            <p className="font-mono text-sm font-semibold tabular-nums text-gold">
              {fmtCountdown(status.resumesAt.getTime() - now.getTime())}
            </p>
            <p className="text-[11px] text-muted-foreground">
              Resumes{" "}
              {status.resumesAt.toLocaleString(undefined, {
                weekday: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}{" "}
              local
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
