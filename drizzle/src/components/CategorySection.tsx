import { cn } from "@/lib/utils";
import type { CategoryDef } from "@/lib/signalCategories";
import { Activity, Landmark, LineChart, Zap, Coins } from "lucide-react";

const ICONS = {
  "gold-scalp": Zap,
  gold: Landmark,
  forex: LineChart,
  indices: Activity,
  crypto: Coins,
  other: Activity,
} as const;

const accentBox: Record<CategoryDef["accent"], string> = {
  gold: "border-gold/35 bg-gold/5",
  bull: "border-bull/25 bg-bull/5",
  purple: "border-violet-500/30 bg-violet-500/5",
  default: "border-border/60 surface-1",
};

const accentIcon: Record<CategoryDef["accent"], string> = {
  gold: "bg-gold/15 text-gold",
  bull: "bg-bull/15 text-bull",
  purple: "bg-violet-500/15 text-violet-300",
  default: "surface-2 text-foreground/80",
};

const accentBadge: Record<CategoryDef["accent"], string> = {
  gold: "border-gold/40 bg-gold/10 text-gold",
  bull: "border-bull/40 bg-bull/10 text-bull",
  purple: "border-violet-500/40 bg-violet-500/10 text-violet-300",
  default: "border-border/60 surface-2 text-muted-foreground",
};

export function CategorySection({
  cat,
  count,
  children,
  id,
}: {
  cat: CategoryDef;
  count: number;
  children: React.ReactNode;
  id?: string;
}) {
  const Icon = ICONS[cat.id] ?? Activity;
  return (
    <section
      id={id ?? `cat-${cat.id}`}
      className={cn("scroll-mt-24 rounded-xl border p-3 sm:p-5", accentBox[cat.accent])}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
              accentIcon[cat.accent],
            )}
          >
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold tracking-tight">{cat.title}</h3>
            <p className="text-[11px] text-muted-foreground truncate">{cat.subtitle}</p>
          </div>
        </div>
        <span
          className={cn(
            "rounded-full border px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider",
            accentBadge[cat.accent],
          )}
        >
          {count}
        </span>
      </div>
      {children}
    </section>
  );
}

/** Horizontal category jump chips — mobile friendly */
export function CategoryNav({
  items,
}: {
  items: { id: string; label: string; count: number }[];
}) {
  if (items.length <= 1) return null;
  return (
    <div className="mb-4 -mx-1 flex gap-2 overflow-x-auto px-1 pb-1 scrollbar-none">
      {items.map((it) => (
        <a
          key={it.id}
          href={`#${it.id}`}
          className="shrink-0 rounded-full border border-border/60 surface-2 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-gold/40 hover:text-foreground active:scale-[0.98]"
        >
          {it.label}
          <span className="ml-1.5 font-mono text-gold">{it.count}</span>
        </a>
      ))}
    </div>
  );
}
