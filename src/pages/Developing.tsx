import { Radar, Zap } from "lucide-react";
import { DevelopingSetupCard } from "@/components/DevelopingSetupCard";
import { SectionHeader } from "@/components/SectionHeader";
import { CategorySection, CategoryNav } from "@/components/CategorySection";
import { useMarketScan } from "@/hooks/useMarketScan";
import { groupDeveloping } from "@/lib/signalCategories";

export default function Developing() {
  const { developing, newsCount, loading } = useMarketScan();

  return (
    <div className="space-y-5">
      <SectionHeader
        icon={Radar}
        title="Developing"
        subtitle="Building confluence — not on the book yet"
        right={
          <>
            {newsCount > 0 && (
              <span className="flex items-center gap-1 rounded bg-gold/10 px-1.5 py-0.5 text-xs font-medium text-gold">
                <Zap className="h-3 w-3" />
                {newsCount} news-driven
              </span>
            )}
            <span className="text-xs text-muted-foreground">{developing.length} forming</span>
          </>
        }
      />

      {developing.length === 0 && !loading && (
        <div className="rounded-xl border border-border/60 bg-card/40 p-6 text-center text-sm text-muted-foreground">
          No developing setups — no structure forming across scanned instruments.
        </div>
      )}

      {developing.length > 0 && (() => {
        const groups = groupDeveloping(developing);
        const nav = groups.map((g) => ({
          id: `dev-${g.cat.id}`,
          label: g.cat.title,
          count: g.items.length,
        }));
        return (
          <div className="space-y-5">
            <CategoryNav items={nav} />
            {groups.map(({ cat, items }) => (
              <CategorySection key={`dev-${cat.id}`} cat={cat} count={items.length} id={`dev-${cat.id}`}>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {items.map((d, i) => (
                    <DevelopingSetupCard key={d.pair} setup={d} index={i} />
                  ))}
                </div>
              </CategorySection>
            ))}
          </div>
        );
      })()}
    </div>
  );
}
