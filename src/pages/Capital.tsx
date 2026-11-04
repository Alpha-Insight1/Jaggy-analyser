import { Wallet } from "lucide-react";
import { CapitalPanel } from "@/components/CapitalPanel";
import { SectionHeader } from "@/components/SectionHeader";
import { useMarketScan } from "@/hooks/useMarketScan";

export default function Capital() {
  const { priceMap } = useMarketScan();

  return (
    <div className="space-y-5">
      <SectionHeader
        icon={Wallet}
        title="Paper capital"
        subtitle="Position sizing from your account settings"
      />
      <CapitalPanel priceMap={priceMap} />
    </div>
  );
}
