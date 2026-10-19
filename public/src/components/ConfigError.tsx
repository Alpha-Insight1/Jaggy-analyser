import { AlertTriangle } from "lucide-react";

export const ConfigError = () => (
  <div className="flex min-h-screen items-center justify-center px-4">
    <div className="w-full max-w-md rounded-2xl border border-border/60 surface-1 p-7">
      <AlertTriangle className="mb-3 h-6 w-6 text-gold" />
      <h1 className="text-lg font-semibold tracking-tight">Backend not configured</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This build is missing <code className="font-mono">VITE_SUPABASE_URL</code> and/or{" "}
        <code className="font-mono">VITE_SUPABASE_PUBLISHABLE_KEY</code>. Set them in{" "}
        <code className="font-mono">.env</code> for local development, or as repository
        variables for the GitHub Actions build, then rebuild.
      </p>
    </div>
  </div>
);
