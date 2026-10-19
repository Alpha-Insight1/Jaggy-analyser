import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, ShieldCheck, Target, Layers } from "lucide-react";
import { BrandLogo } from "@/components/BrandLogo";
import { toast } from "sonner";

const ALLOW_SIGNUP = import.meta.env.VITE_ALLOW_SIGNUP !== "false";

const highlights = [
  { icon: Layers, text: "BOS / CHoCH structure with Order Block and FVG confluence" },
  { icon: Target, text: "ATR-based risk model with transparent confidence scoring" },
  { icon: ShieldCheck, text: "Private, sign-in-only access to every signal" },
];

const Auth = () => {
  const navigate = useNavigate();
  const { user, loading } = useAuth();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  if (loading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 surface-0 px-4">
        <BrandLogo size={48} className="shadow-gold" />
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }
  if (user) return <Navigate to="/" replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}${import.meta.env.BASE_URL}` },
        });
        if (error) throw error;
        toast.success("Account created — check your inbox to confirm your email.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        navigate("/");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Brand panel */}
      <aside className="relative hidden flex-col justify-between border-r border-border/60 surface-1 p-10 lg:flex">
        <div className="flex items-center gap-3">
          <BrandLogo size={40} className="shadow-gold" />
          <span className="text-lg font-semibold tracking-tight">Jaggy Analyser</span>
        </div>

        <div className="max-w-md">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">
            Institutional-style swing analysis, scanned continuously.
          </h2>
          <p className="mt-3 text-sm text-muted-foreground">
            Forex, indices, Gold and more — multi-timeframe SMC with clear swing and scalp setups.
          </p>
          <ul className="mt-8 space-y-4">
            {highlights.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3 text-sm">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/60 surface-2">
                  <Icon className="h-3.5 w-3.5 text-gold" />
                </span>
                <span className="text-muted-foreground">{text}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="text-xs text-muted-foreground">
          Educational analysis only. Not financial advice.
        </p>
      </aside>

      {/* Form */}
      <main className="flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3">
            <BrandLogo size={44} className="shadow-gold" />
            <div className="leading-tight">
              <p className="text-lg font-semibold tracking-tight">Jaggy Analyser</p>
              <p className="text-[11px] text-muted-foreground">SMC multi-TF desk</p>
            </div>
          </div>

          <h1 className="text-2xl font-semibold tracking-tight">
            {mode === "signin" ? "Welcome back" : "Create your account"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === "signin"
              ? "Sign in to view live signals and your paper account."
              : "Start with a paper account — no real funds involved."}
          </p>

          <form onSubmit={submit} className="mt-7 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                required
                minLength={8}
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {mode === "signup" && (
                <p className="text-xs text-muted-foreground">At least 8 characters.</p>
              )}
            </div>
            <Button type="submit" className="w-full gap-2" disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {mode === "signin" ? "Sign in" : "Create account"}
            </Button>
          </form>

          {ALLOW_SIGNUP ? (
            <button
              type="button"
              onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
              className="mt-6 w-full text-center text-sm text-muted-foreground transition-smooth hover:text-foreground"
            >
              {mode === "signin" ? "No account yet? Create one" : "Already have an account? Sign in"}
            </button>
          ) : (
            <p className="mt-6 text-center text-xs text-muted-foreground">
              Access is by invitation only.
            </p>
          )}
        </div>
      </main>
    </div>
  );
};

export default Auth;
