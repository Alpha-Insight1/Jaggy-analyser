import { Activity } from "lucide-react";
import { SignalCard } from "@/components/SignalCard";
import { SectionHeader } from "@/components/SectionHeader";
import { CategorySection, CategoryNav } from "@/components/CategorySection";
import { useMarketScan } from "@/hooks/useMarketScan";
import { groupSignals } from "@/lib/signalCategories";

export default function Signals() {
  const { data, loading, lastUpdated } = useMarketScan();
  const signals = data?.signals ?? [];

  return (
    <div className="space-y-5">
      <SectionHeader
        icon={Activity}
        title="Live LTF signals"
        subtitle="Confirmed setups — LTF limit is the live trigger on the trade book"
        right={
          lastUpdated && (
            <span className="font-mono text-xs">Updated {lastUpdated.toLocaleTimeString()}</span>
          )
        }
      />

      {loading && !data && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-64 animate-pulse rounded-xl border border-border/60 bg-card/40"
            />
          ))}
        </div>
      )}

      {data && signals.length === 0 && !loading && (
        <div className="rounded-xl border border-dashed border-border/60 bg-card/40 p-10 text-center">
          <Activity className="mx-auto h-8 w-8 text-muted-foreground/40" />
          <p className="mt-3 font-medium">No live LTF signals right now</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Scanned {data.scanned.length} instruments · waiting for structure + LTF confirmation
          </p>
        </div>
      )}

      {signals.length > 0 && (() => {
        const groups = groupSignals(signals);
        const nav = groups.map((g) => ({
          id: `active-${g.cat.id}`,
          label: g.cat.title,
          count: g.items.length,
        }));
        return (
          <div className="space-y-5">
            <CategoryNav items={nav} />
            {groups.map(({ cat, items }) => (
              <CategorySection key={cat.id} cat={cat} count={items.length} id={`active-${cat.id}`}>
                <div className="grid gap-3 sm:gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {items.map((s, i) => (
                    <SignalCard key={`${cat.id}-${s.pair}-${s.timestamp}`} signal={s} index={i} />
                  ))}
                </div>
              </CategorySection>
            ))}
          </div>
        );
      })()}

      {data && data.errors.length > 0 && (
        <details className="rounded-lg border border-border/50 bg-card/40 px-3 py-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium">
            {data.errors.length} instrument{data.errors.length > 1 ? "s" : ""} failed to scan
          </summary>
          <ul className="mt-2 space-y-1 font-mono">
            {data.errors.map((e) => (
              <li key={e.pair}>
                {e.pair}: {e.error}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
