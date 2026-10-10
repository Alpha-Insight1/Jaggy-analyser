import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { SignalCard, type Signal } from "@/components/SignalCard";
import { DevelopingSetupCard, type DevelopingSetup } from "@/components/DevelopingSetupCard";
import { TradeBook } from "@/components/TradeBook";
import { EquityCurve } from "@/components/EquityCurve";
import { PerPairStats } from "@/components/PerPairStats";
import { Button } from "@/components/ui/button";
import { RefreshCw, Activity, AlertCircle, Radar, Zap, ArrowUp, ArrowDown } from "lucide-react";
import { BrandLogo } from "@/components/BrandLogo";
import { NotificationToggle } from "@/components/NotificationToggle";
import { ThemePicker } from "@/components/ThemePicker";
import { MarketStatusBanner } from "@/components/MarketStatusBanner";
import { CapitalPanel } from "@/components/CapitalPanel";
import { AccountButton } from "@/components/AccountButton";
import { SectionHeader } from "@/components/SectionHeader";
import { SummaryStrip } from "@/components/SummaryStrip";

import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface AnalysisResponse {
  signals: Signal[];
  developing: DevelopingSetup[];
  scanned: string[];
  errors: { pair: string; error: string }[];
  resolved?: number;
}

// Rescan every 3 minutes
const REFRESH_MS = 3 * 60 * 1000;

function loadSeenSignals(): Set<string> {
  try {
    const raw = JSON.parse(sessionStorage.getItem("seenSignals") ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

const Index = () => {
  const [data, setData] = useState<AnalysisResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [countdown, setCountdown] = useState(REFRESH_MS / 1000);
  // Track which signals we've already alerted on (pair + timestamp).
  // Persists across refreshes via sessionStorage so a tab reload doesn't re-alert.
  const seenSignals = useRef<Set<string>>(loadSeenSignals());
  const isFirstLoad = useRef(true);
  const inFlight = useRef(false);

  const fireAlert = useCallback((s: Signal) => {
    const isBuy = s.direction === "BUY";
    toast.success(`${s.direction} ${s.pair} · ${s.confidence}%`, {
      description: `Entry ${s.entry} · SL ${s.stopLoss} · TP ${s.takeProfit}`,
      duration: 12000,
      icon: isBuy ? <ArrowUp className="h-4 w-4 text-bull" /> : <ArrowDown className="h-4 w-4 text-bear" />,
    });
    // Browser notification if user has granted permission
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
        { body: {} }
      );
      if (fnError) throw fnError;
      if (!result) throw new Error("No data returned");

      // Detect newly fired signals — on first load, mark all as seen without
      // alerting (so refresh doesn't spam). On subsequent loads, alert on diffs.
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
      setError(e instanceof Error ? e.message : "Failed to load signals");
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [fireAlert]);

  useEffect(() => {
    fetchSignals();
    const interval = setInterval(fetchSignals, REFRESH_MS);
    return () => clearInterval(interval);
  }, [fetchSignals]);

  useEffect(() => {
    const t = setInterval(() => setCountdown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  const priceMap = useMemo(() => buildPriceMap(data), [data]);

  const mins = Math.floor(countdown / 60);
  const secs = countdown % 60;

  const developing = data?.developing ?? [];
  const newsCount = developing.filter((d) => d.newsMomentum).length;

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-border/60 surface-1/80 backdrop-blur-md">
        <div className="container flex flex-col gap-3 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <BrandLogo size={36} className="shadow-gold" />
            <div className="leading-tight">
              <h1 className="text-base font-semibold tracking-tight">Jaggy Analyser</h1>
              <p className="text-[11px] text-muted-foreground">SMC multi-TF desk · Forex 15M · Indices/Gold 5M · Gold scalp</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 rounded-md border border-border/60 surface-2 px-3 py-1.5 text-xs">
              <span className="relative flex h-2 w-2">
                <span
                  className={cn(
                    "absolute inset-0 rounded-full",
                    error ? "bg-bear" : loading ? "bg-gold animate-pulse" : "bg-bull pulse-dot",
                  )}
                />
              </span>
              <span className="font-medium">{error ? "Feed error" : loading ? "Scanning" : "Live"}</span>
              <span className="text-border">|</span>
              <span className="font-mono tabular-nums text-muted-foreground">
                {loading
                  ? "…"
                  : `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`}
              </span>
            </div>
            <NotificationToggle />
            <ThemePicker />
            <Button size="sm" variant="secondary" onClick={fetchSignals} disabled={loading} className="gap-2">
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
            <div className="mx-1 hidden h-6 w-px bg-border/60 sm:block" />
            <AccountButton />
          </div>
        </div>
      </header>

      <main className="container py-8">
        <MarketStatusBanner />

        <SummaryStrip
          signals={data?.signals ?? []}
          developing={developing}
          scanned={data?.scanned.length ?? 0}
          failed={data?.errors.length ?? 0}
          loading={loading && !data}
        />

        {error && (
          <div className="mb-6 flex items-start gap-3 rounded-lg border border-bear/30 bg-bear/10 p-4 text-sm">
            <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-bear" />
            <div>
              <p className="font-medium">Couldn't load signals</p>
              <p className="text-muted-foreground">{error}</p>
            </div>
          </div>
        )}

        {/* ——— ACTIVE SIGNALS (primary) ——— */}
        <section className="mb-10">
          <SectionHeader
            icon={Activity}
            title="Active signals"
            subtitle="Ready to trade — swing setups + Gold scalps"
            right={
              lastUpdated && (
                <span className="font-mono">Updated {lastUpdated.toLocaleTimeString()}</span>
              )
            }
          />

          {loading && !data && <SkeletonGrid />}

          {data && data.signals.length === 0 && !loading && (
            <div className="rounded-xl border border-dashed border-border/60 surface-1 p-10 text-center">
              <Activity className="mx-auto h-8 w-8 text-muted-foreground/40" />
              <p className="mt-3 font-medium">No active signals right now</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Scanned {data.scanned.length} instruments · waiting for clean structure + entry confirmation
              </p>
            </div>
          )}

          {data && data.signals.length > 0 && (() => {
            const scalpSignals = data.signals.filter((s) => s.signalStyle === "scalp");
            const swingSignals = data.signals.filter((s) => s.signalStyle !== "scalp");
            return (
              <div className="space-y-8">
                {/* Gold / scalp callout */}
                {scalpSignals.length > 0 && (
                  <div className="rounded-xl border border-gold/40 bg-gold/5 p-4 md:p-5">
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-gold/20 text-gold">
                          <Zap className="h-4 w-4" />
                        </span>
                        <div>
                          <p className="text-sm font-semibold tracking-tight text-gold">
                            Gold scalp — active now
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            1H trend · 5M break of structure · tighter stops
                          </p>
                        </div>
                      </div>
                      <span className="rounded-full border border-gold/40 bg-gold/10 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-gold">
                        {scalpSignals.length} scalp{scalpSignals.length > 1 ? "s" : ""}
                      </span>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                      {scalpSignals.map((s, i) => (
                        <SignalCard key={`scalp-${s.pair}-${s.timestamp}`} signal={s} index={i} />
                      ))}
                    </div>
                  </div>
                )}

                {/* Swing signals */}
                {swingSignals.length > 0 && (
                  <div>
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="flex h-7 w-7 items-center justify-center rounded-md border border-border/60 surface-2">
                          <Activity className="h-4 w-4 text-foreground/80" />
                        </span>
                        <div>
                          <p className="text-sm font-semibold tracking-tight">Swing setups</p>
                          <p className="text-[11px] text-muted-foreground">
                            Forex 15M · Indices &amp; Gold 5M · 4H structure + Daily bias
                          </p>
                        </div>
                      </div>
                      <span className="rounded-full border border-border/60 surface-2 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                        {swingSignals.length} active
                      </span>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                      {swingSignals.map((s, i) => (
                        <SignalCard key={`swing-${s.pair}-${s.timestamp}`} signal={s} index={i} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {data && data.errors.length > 0 && (
            <details className="mt-6 rounded-lg border border-border/60 surface-1 p-4 text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                {data.errors.length} pair(s) failed to load
              </summary>
              <ul className="mt-2 space-y-1 font-mono text-muted-foreground">
                {data.errors.map((e, i) => (
                  <li key={i}>
                    {e.pair}: {e.error}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>

        {/* Developing setups — secondary */}
        <section className="mb-10">
          <SectionHeader
            icon={Radar}
            title="Developing setups"
            subtitle="Not ready yet — watch these for a possible entry"
            right={
              <>
                {newsCount > 0 && (
                  <span className="flex items-center gap-1 rounded bg-gold/10 px-1.5 py-0.5 font-medium text-gold">
                    <Zap className="h-3 w-3" />
                    {newsCount} news-driven
                  </span>
                )}
                <span>{developing.length} forming</span>
              </>
            }
          />

          {developing.length === 0 && !loading && (
            <div className="rounded-xl border border-border/60 surface-1 p-6 text-center text-sm text-muted-foreground">
              No setups developing — the market is quiet across scanned instruments.
            </div>
          )}

          {developing.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {developing.map((d, i) => (
                <DevelopingSetupCard key={d.pair} setup={d} index={i} />
              ))}
            </div>
          )}
        </section>

        {/* Managed paper capital — auto-sized positions mirrored from live signals */}
        <CapitalPanel priceMap={priceMap} />

        {/* Trade book + analytics — pass latest scanned prices so open trades can be marked-to-market */}
        <TradeBook priceMap={priceMap} />
        <EquityCurve />
        <PerPairStats />

        <footer className="mt-12 flex flex-col items-center justify-between gap-2 border-t border-border/60 py-6 text-xs text-muted-foreground sm:flex-row">
          <p>© {new Date().getFullYear()} Jaggy Analyser</p>
          <p className="max-w-xl text-center sm:text-right">
            Educational analysis only — not financial advice. Trading leveraged products carries a
            high risk of loss. Confirm every setup on your own charts.
          </p>
        </footer>
      </main>
    </div>
  );
};

const SkeletonGrid = () => (
  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
    {Array.from({ length: 3 }).map((_, i) => (
      <div
        key={i}
        className="h-64 animate-pulse rounded-xl border border-border/60 surface-1"
        style={{ animationDelay: `${i * 80}ms` }}
      />
    ))}
  </div>
);

export default Index;

/**
 * Build a pair → latest-price map from the scanner response so open trades can
 * be marked-to-market in the Trade Book without a second network call.
 */
function buildPriceMap(data: AnalysisResponse | null): Record<string, number> {
  const map: Record<string, number> = {};
  if (!data) return map;
  for (const s of data.signals) map[s.pair] = s.currentPrice;
  for (const d of data.developing) map[d.pair] = d.currentPrice;
  return map;
}
