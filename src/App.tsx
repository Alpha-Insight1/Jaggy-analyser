import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Auth from "./pages/Auth.tsx";
import NotFound from "./pages/NotFound.tsx";
import Overview from "./pages/Overview.tsx";
import Signals from "./pages/Signals.tsx";
import Developing from "./pages/Developing.tsx";
import Book from "./pages/Book.tsx";
import Capital from "./pages/Capital.tsx";
import { AuthProvider, useAuth } from "@/hooks/useAuth";
import { isSupabaseConfigured } from "@/integrations/supabase/client";
import { ConfigError } from "@/components/ConfigError";
import { BrandLogo } from "@/components/BrandLogo";
import { MarketScanProvider } from "@/hooks/useMarketScan";
import { AppShell } from "@/components/AppShell";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

const ProtectedShell = () => {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 surface-0 px-4">
        <BrandLogo size={52} withWordmark />
        <p className="text-sm text-muted-foreground">Loading Jaggy Analyser…</p>
      </div>
    );
  }
  if (!user) return <Navigate to="/auth" replace />;

  return (
    <MarketScanProvider>
      <AppShell />
    </MarketScanProvider>
  );
};

const App = () =>
  !isSupabaseConfigured ? (
    <ConfigError />
  ) : (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <AuthProvider>
          <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Routes>
              <Route path="/auth" element={<Auth />} />
              <Route element={<ProtectedShell />}>
                <Route path="/" element={<Overview />} />
                <Route path="/signals" element={<Signals />} />
                <Route path="/developing" element={<Developing />} />
                <Route path="/book" element={<Book />} />
                <Route path="/capital" element={<Capital />} />
              </Route>
              <Route path="*" element={<NotFound />} />
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );

export default App;
