import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Signal } from "@/components/SignalCard";
import type { DevelopingSetup } from "@/components/DevelopingSetupCard";
import { toast } from "sonner";
import { ArrowUp, ArrowDown } from "lucide-react";

export interface AnalysisResponse {
  signals: Signal[];
  developing: DevelopingSetup[];
  scanned: string[];
  errors: { pair: string; error: string }[];
  resolved?: number;
}

const REFRESH_MS = 3 * 60 * 1000;

function loadSeenSignals(): Set<string> {
  try {
    const raw = JSON.parse(sessionStorage.getItem("seenSignals") ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

interface MarketScanValue {
  data: AnalysisResponse | null;
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  countdown: number;
  fetchSignals: () => Promise<void>;
  developing: DevelopingSetup[];
  newsCount: number;
  priceMap: Record<string, number>;
}

const MarketScanContext = createContext<MarketScanValue | null>(null);

export function MarketScanProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<AnalysisResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [countdown, setCountdown] = useState(REFRESH_MS / 1000);
  const seenSignals = useRef<Set<string>>(loadSeenSignals());
  const isFirstLoad = useRef(true);
  const inFlight = useRef(false);

  const fireAlert = useCallback((s: Signal) => {
    const isBuy = s.direction === "BUY";
    toast.success(
      `${s.signalStyle === "scalp" ? "Scalp · " : "LTF · "}${s.direction} ${s.pair} · ${s.confidence}%`,
      {
        description: `Entry ${s.entry} · SL ${s.stopLoss} · TP ${s.takeProfit}`,
        duration: 12000,
        icon: isBuy ? (
          <ArrowUp className="h-4 w-4 text-bull" />
        ) : (
          <ArrowDown className="h-4 w-4 text-bear" />
        ),
      },
    );
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(`${s.direction} ${s.pair} fired (${s.confidence}%)`, {
        body: `Entry ${s.entry} · SL ${s.stopLoss} · TP ${s.takeProfit}`,
        tag: `${s.pair}-${s.timestamp}`,
      });
    }
  }, []);

  const fetchSignals = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      const { data: result, error: fnError } = await supabase.functions.invoke<AnalysisResponse>(
        "forex-analysis",
        { body: {} },
      );
      if (fnError) throw fnError;
      if (!result) throw new Error("No data returned");

      for (const s of result.signals) {
        const key = `${s.pair}-${s.timestamp}`;
        if (!seenSignals.current.has(key)) {
          if (!isFirstLoad.current) fireAlert(s);
          seenSignals.current.add(key);
        }
      }
      sessionStorage.setItem(
        "seenSignals",
        JSON.stringify(Array.from(seenSignals.current).slice(-200)),
      );
      isFirstLoad.current = false;

      setData(result);
      setLastUpdated(new Date());
      setCountdown(REFRESH_MS / 1000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error("Scan failed", { description: msg });
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, [fireAlert]);

  useEffect(() => {
    void fetchSignals();
    const id = window.setInterval(() => void fetchSignals(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [fetchSignals]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setCountdown((c) => (c <= 0 ? 0 : c - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const developing = data?.developing ?? [];
  const newsCount = developing.filter((d) => d.newsMomentum).length;
  const priceMap = useMemo(() => {
    const map: Record<string, number> = {};
    if (!data) return map;
    for (const s of data.signals) map[s.pair] = s.currentPrice;
    for (const d of data.developing) map[d.pair] = d.currentPrice;
    return map;
  }, [data]);

  const value: MarketScanValue = {
    data,
    loading,
    error,
    lastUpdated,
    countdown,
    fetchSignals,
    developing,
    newsCount,
    priceMap,
  };

  return <MarketScanContext.Provider value={value}>{children}</MarketScanContext.Provider>;
}

export function useMarketScan() {
  const ctx = useContext(MarketScanContext);
  if (!ctx) throw new Error("useMarketScan must be used within MarketScanProvider");
  return ctx;
}
