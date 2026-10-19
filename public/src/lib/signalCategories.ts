import type { Signal } from "@/components/SignalCard";
import type { DevelopingSetup } from "@/components/DevelopingSetupCard";

export type CategoryId = "gold-scalp" | "gold" | "forex" | "indices" | "crypto" | "other";

export interface CategoryDef {
  id: CategoryId;
  title: string;
  subtitle: string;
  accent: "gold" | "bull" | "default" | "purple";
}

export const CATEGORIES: CategoryDef[] = [
  {
    id: "gold-scalp",
    title: "Gold scalp",
    subtitle: "1H trend · 5M / 1M entry · tighter risk",
    accent: "gold",
  },
  {
    id: "gold",
    title: "Gold swing",
    subtitle: "1D + 4H structure · 5M entry",
    accent: "gold",
  },
  {
    id: "forex",
    title: "Forex",
    subtitle: "1D + 4H structure · 15M / 30M entry",
    accent: "bull",
  },
  {
    id: "indices",
    title: "Indices",
    subtitle: "1D + 4H structure · 5M entry",
    accent: "default",
  },
  {
    id: "crypto",
    title: "Crypto",
    subtitle: "BTC / ETH and majors",
    accent: "purple",
  },
  {
    id: "other",
    title: "Other",
    subtitle: "Unclassified instruments",
    accent: "default",
  },
];

function isGold(pair: string) {
  const p = pair.toUpperCase();
  return p.includes("XAU") || p.includes("GOLD");
}
function isCrypto(pair: string) {
  const p = pair.toUpperCase();
  return (
    p.includes("BTC") ||
    p.includes("ETH") ||
    p.includes("XRP") ||
    p.includes("SOL") ||
    p.includes("USDT")
  );
}
function isIndex(pair: string) {
  const p = pair.toUpperCase();
  return (
    p.includes("US30") ||
    p.includes("NAS") ||
    p.includes("SPX") ||
    p.includes("GER") ||
    p.includes("UK100") ||
    p.includes("JPN") ||
    p.includes("NDX") ||
    p.includes("DJ") ||
    p.includes("DAX") ||
    p.includes("US500") ||
    p.includes("DE40")
  );
}

export function categoryOfSignal(s: Signal): CategoryId {
  if (s.signalStyle === "scalp" && isGold(s.pair)) return "gold-scalp";
  if (s.signalStyle === "scalp") return "gold-scalp";
  if (isGold(s.pair)) return "gold";
  if (isCrypto(s.pair)) return "crypto";
  if (isIndex(s.pair)) return "indices";
  if (/^[A-Z]{3}\/[A-Z]{3}$/i.test(s.pair)) return "forex";
  return "other";
}

export function categoryOfDeveloping(d: DevelopingSetup): CategoryId {
  if (isGold(d.pair)) return "gold";
  if (isCrypto(d.pair)) return "crypto";
  if (isIndex(d.pair)) return "indices";
  if (/^[A-Z]{3}\/[A-Z]{3}$/i.test(d.pair)) return "forex";
  return "other";
}

export function groupSignals(signals: Signal[]): { cat: CategoryDef; items: Signal[] }[] {
  const map = new Map<CategoryId, Signal[]>();
  for (const s of signals) {
    const id = categoryOfSignal(s);
    const list = map.get(id) ?? [];
    list.push(s);
    map.set(id, list);
  }
  return CATEGORIES.map((cat) => ({ cat, items: map.get(cat.id) ?? [] })).filter(
    (g) => g.items.length > 0,
  );
}

export function groupDeveloping(
  items: DevelopingSetup[],
): { cat: CategoryDef; items: DevelopingSetup[] }[] {
  const map = new Map<CategoryId, DevelopingSetup[]>();
  for (const d of items) {
    const id = categoryOfDeveloping(d);
    const list = map.get(id) ?? [];
    list.push(d);
    map.set(id, list);
  }
  return CATEGORIES.filter((c) => c.id !== "gold-scalp")
    .map((cat) => ({ cat, items: map.get(cat.id) ?? [] }))
    .filter((g) => g.items.length > 0);
}
