import { BookOpen } from "lucide-react";
import { TradeBook } from "@/components/TradeBook";
import { EquityCurve } from "@/components/EquityCurve";
import { PerPairStats } from "@/components/PerPairStats";
import { SectionHeader } from "@/components/SectionHeader";
import { useMarketScan } from "@/hooks/useMarketScan";

export default function Book() {
  const { priceMap } = useMarketScan();

  return (
    <div className="space-y-5">
      <SectionHeader
        icon={BookOpen}
        title="Trade book · LTF monitoring"
        subtitle="Armed LTF limits · fills on touch · track SL / TP1 / TP2 live"
      />
      <TradeBook priceMap={priceMap} />
      <div className="grid gap-4 lg:grid-cols-2">
        <EquityCurve />
        <PerPairStats />
      </div>
    </div>
  );
}
