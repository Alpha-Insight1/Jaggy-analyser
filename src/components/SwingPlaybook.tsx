import { Bell, Crosshair, Flag, Ban, ChevronDown } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Always-visible swing desk rules so users know:
 * - this app only books swing setups
 * - when to alert vs place a limit vs stay out
 */
export function SwingPlaybook({ className }: { className?: string }) {
  const [open, setOpen] = useState(true);

  const steps = [
    {
      icon: Bell,
      title: "1 · Watchlist",
      body: "Developing cards = early structure. Set a price alert near the swing zone. Do not enter yet.",
      tone: "gold" as const,
    },
    {
      icon: Crosshair,
      title: "2 · Arm limit",
      body: "Active signal = LIMIT in the deep entry zone (after liquidity). Never in the shallow BOS grab zone. LTF is context only.",
      tone: "bull" as const,
    },
    {
      icon: Flag,
      title: "3 · Manage",
      body: "Stop beyond the Daily zone. Take partial at TP1 (2R). Leave a runner to TP2 (4R).",
      tone: "bull" as const,
    },
    {
      icon: Ban,
      title: "4 · Stay out",
      body: "If the card says invalidated, counter-bias, or watch only — cancel limits. No chase.",
      tone: "bear" as const,
    },
  ];

  return (
    <section
      className={cn(
        "mb-6 overflow-hidden rounded-lg border border-primary/25 bg-primary/5",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-smooth hover:bg-primary/10"
      >
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-primary">
            Swing desk only
          </p>
          <p className="mt-0.5 text-sm font-semibold text-foreground">
            Market structure playbook · how to use this board
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Sweep+BOS swing · Fib discount/premium · skip liquidity grab · TP1 2R · TP2 4R
          </p>
        </div>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="border-t border-primary/15 px-4 py-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {steps.map(({ icon: Icon, title, body, tone }) => (
              <div
                key={title}
                className={cn(
                  "rounded-md border p-3",
                  tone === "gold" && "border-primary/30 bg-background/40",
                  tone === "bull" && "border-bull/25 bg-background/40",
                  tone === "bear" && "border-bear/25 bg-background/40",
                )}
              >
                <div className="flex items-center gap-2">
                  <Icon
                    className={cn(
                      "h-3.5 w-3.5",
                      tone === "gold" && "text-primary",
                      tone === "bull" && "text-bull",
                      tone === "bear" && "text-bear",
                    )}
                  />
                  <p className="text-[11px] font-bold uppercase tracking-wide text-foreground">
                    {title}
                  </p>
                </div>
                <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[10px] text-muted-foreground">
            Structure first (sweep + BOS) · Fib value area · session filter · no LTF scalps ·
            educational analysis only, not financial advice.
          </p>
        </div>
      )}
    </section>
  );
}

export default SwingPlaybook;
