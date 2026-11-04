import { NavLink, Outlet } from "react-router-dom";
import {
  Activity,
  BookOpen,
  LayoutDashboard,
  Radar,
  RefreshCw,
  Wallet,
} from "lucide-react";
import { BrandLogo } from "@/components/BrandLogo";
import { NotificationToggle } from "@/components/NotificationToggle";
import { ThemePicker } from "@/components/ThemePicker";
import { AccountButton } from "@/components/AccountButton";
import { MarketStatusBanner } from "@/components/MarketStatusBanner";
import { Button } from "@/components/ui/button";
import { useMarketScan } from "@/hooks/useMarketScan";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/signals", label: "Signals", icon: Activity },
  { to: "/developing", label: "Developing", icon: Radar },
  { to: "/book", label: "Trade book", icon: BookOpen },
  { to: "/capital", label: "Capital", icon: Wallet },
] as const;

export function AppShell() {
  const { loading, error, countdown, fetchSignals, data } = useMarketScan();
  const mins = Math.floor(countdown / 60);
  const secs = countdown % 60;
  const liveCount = data?.signals.length ?? 0;
  const devCount = data?.developing.length ?? 0;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-border/40 bg-background/85 backdrop-blur-xl pt-safe">
        <div className="container mx-auto flex max-w-7xl flex-col gap-3 px-3 py-2.5 sm:px-5 sm:py-3">
          <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <BrandLogo size={40} withWordmark className="shrink-0" />
              <div className="hidden min-w-0 border-l border-border/50 pl-3 leading-tight sm:block">
                <p className="text-[11px] text-muted-foreground truncate">
                  LTF desk · monitor fills · multi-TF SMC
                </p>
                <p className="text-[10px] text-muted-foreground/80 truncate">
                  Each section has its own page · book tracks live R
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2 rounded-md border border-border/50 bg-card/60 px-3 py-1.5 text-xs">
                <span className="relative flex h-2 w-2">
                  <span
                    className={cn(
                      "absolute inset-0 rounded-full",
                      error ? "bg-bear" : loading ? "bg-gold animate-pulse" : "bg-bull",
                    )}
                  />
                </span>
                <span className="font-medium">
                  {error ? "Feed error" : loading ? "Scanning" : "Live"}
                </span>
                <span className="text-border">|</span>
                <span className="font-mono tabular-nums text-muted-foreground">
                  {loading
                    ? "…"
                    : `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`}
                </span>
              </div>
              <NotificationToggle />
              <ThemePicker />
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void fetchSignals()}
                disabled={loading}
                className="gap-2"
              >
                <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
                <span className="hidden sm:inline">Refresh</span>
              </Button>
              <div className="mx-1 hidden h-6 w-px bg-border/60 sm:block" />
              <AccountButton />
            </div>
          </div>

          {/* Primary nav */}
          <nav className="-mx-1 flex gap-1 overflow-x-auto pb-0.5 scrollbar-none">
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    "flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold uppercase tracking-wide transition-smooth",
                    isActive
                      ? "bg-primary/15 text-primary border border-primary/30"
                      : "text-muted-foreground border border-transparent hover:bg-card hover:text-foreground",
                  )
                }
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
                {label === "Signals" && liveCount > 0 && (
                  <span className="rounded-full bg-primary/20 px-1.5 py-0.5 font-mono text-[10px] text-primary">
                    {liveCount}
                  </span>
                )}
                {label === "Developing" && devCount > 0 && (
                  <span className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                    {devCount}
                  </span>
                )}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main className="container mx-auto max-w-7xl px-3 py-5 sm:px-5 sm:py-7 pb-safe">
        <MarketStatusBanner />
        <Outlet />
      </main>

      <footer className="border-t border-border/40 py-6 text-xs text-muted-foreground">
        <div className="container mx-auto flex max-w-7xl flex-col items-center justify-between gap-2 px-3 sm:flex-row sm:px-5">
          <p>© {new Date().getFullYear()} Jaggy Analyser</p>
          <p className="max-w-xl text-center sm:text-right">
            Educational analysis only — not financial advice. Confirm every setup on your own charts.
          </p>
        </div>
      </footer>
    </div>
  );
}

export default AppShell;
