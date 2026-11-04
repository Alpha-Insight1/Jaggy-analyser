import { Link } from "react-router-dom";
import { Activity, AlertCircle, BookOpen, Radar, Wallet } from "lucide-react";
import { SummaryStrip } from "@/components/SummaryStrip";
import { SwingPlaybook } from "@/components/SwingPlaybook";
import { useMarketScan } from "@/hooks/useMarketScan";
import { cn } from "@/lib/utils";

const tiles = [
  {
    to: "/signals",
    title: "Live signals",
    desc: "Confirmed LTF setups ready to arm",
    icon: Activity,
    tone: "primary" as const,
  },
  {
    to: "/developing",
    title: "Developing",
    desc: "Forming structure — not on the book yet",
    icon: Radar,
    tone: "muted" as const,
  },
  {
    to: "/book",
    title: "Trade book",
    desc: "Monitor LTF fills, SL and targets",
    icon: BookOpen,
    tone: "bull" as const,
  },
  {
    to: "/capital",
    title: "Capital",
    desc: "Paper size and risk settings",
    icon: Wallet,
    tone: "gold" as const,
  },
];

export default function Overview() {
  const { data, loading, error, developing, lastUpdated } = useMarketScan();

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-primary">Overview</p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">Jaggy desk</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a page below. Live scan feeds every section.
          {lastUpdated && (
            <span className="ml-1 font-mono text-xs">
              Updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
        </p>
      </div>

      <SummaryStrip
        signals={data?.signals ?? []}
        developing={developing}
        scanned={data?.scanned.length ?? 0}
        failed={data?.errors.length ?? 0}
        loading={loading && !data}
      />

      {error && (
        <div className="flex items-start gap-3 rounded-xl border border-bear/30 bg-bear/10 p-4 text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-bear" />
          <div>
            <p className="font-medium">Couldn't load signals</p>
            <p className="text-muted-foreground">{error}</p>
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {tiles.map(({ to, title, desc, icon: Icon, tone }) => (
          <Link
            key={to}
            to={to}
            className={cn(
              "group rounded-xl border p-4 transition-smooth hover:-translate-y-0.5 hover:border-primary/40",
              "bg-card/60 border-border/50",
            )}
          >
            <div className="flex items-start gap-3">
              <div
                className={cn(
                  "rounded-lg border p-2",
                  tone === "primary" && "border-primary/30 bg-primary/10 text-primary",
                  tone === "bull" && "border-bull/30 bg-bull/10 text-bull",
                  tone === "gold" && "border-gold/30 bg-gold/10 text-gold",
                  tone === "muted" && "border-border bg-muted/40 text-muted-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold tracking-tight group-hover:text-primary">{title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
              </div>
              <span className="text-muted-foreground/50 transition-smooth group-hover:text-primary">→</span>
            </div>
          </Link>
        ))}
      </div>

      <SwingPlaybook />
    </div>
  );
}
