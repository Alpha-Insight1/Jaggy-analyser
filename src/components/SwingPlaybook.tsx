import { Bell, Crosshair, Flag, Ban, ChevronDown } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/** How to use the SMC multi-TF Jaggy board (Path A LTF + Path B swing). */
export function SwingPlaybook({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);

  const steps = [
    {
      icon: Bell,
      title: "1 · Watchlist",
      body: "Developing cards = structure forming. Wait for a confirmed signal card before entering.",
      tone: "gold" as const,
    },
    {
      icon: Crosshair,
      title: "2 · Choose path",
      body: "Path A = LTF entry (faster). Path B = deeper swing limit when shown. Prefer A+ grades.",
      tone: "bull" as const,
    },
    {
      icon: Flag,
      title: "3 · Manage",
      body: "Use the ticket SL / TP1 / TP2. Partial at TP1 when available; trail or hold runner to TP2.",
      tone: "bull" as const,
    },
    {
      icon: Ban,
      title: "4 · Stay out",
      body: "Skip counter-bias, low confidence, or when the zone is already spent. No chase after the move.",
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
            How this desk works
          </p>
          <p className="mt-0.5 text-sm font-semibold text-foreground">
            LTF limits · structure bias · trade book monitoring
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Daily bias + 4H structure · Forex 15M / Indices &amp; Gold 5M · optional gold scalp
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
            A+ auto-book · structure TPs · session filters · educational analysis only, not financial advice.
          </p>
        </div>
      )}
    </section>
  );
}

export default SwingPlaybook;
