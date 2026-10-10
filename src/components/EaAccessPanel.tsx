import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Bot, Copy, Plus, Trash2, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface EaToken {
  id: string;
  label: string;
  token_prefix: string;
  risk_percent: number;
  symbol_suffix: string;
  revoked: boolean;
  last_used_at: string | null;
  created_at: string;
}

const ENDPOINT = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/mt5-signals?status=open`;

/** Random URL-safe token generated in the browser; only its SHA-256 is stored. */
const makeToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const sha256Hex = async (input: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const copy = (text: string, what: string) => {
  navigator.clipboard.writeText(text);
  toast.success(`${what} copied`);
};

export const EaAccessPanel = () => {
  const { user } = useAuth();
  const [tokens, setTokens] = useState<EaToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState("My MT5 EA");
  const [risk, setRisk] = useState("1");
  const [suffix, setSuffix] = useState("");
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    if (!user) {
      setTokens([]);
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from("ea_tokens")
      .select("id, label, token_prefix, risk_percent, symbol_suffix, revoked, last_used_at, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    setTokens((data ?? []) as EaToken[]);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  if (!user) return null;

  const createToken = async () => {
    setCreating(true);
    try {
      const token = makeToken();
      const { error } = await supabase.from("ea_tokens").insert({
        user_id: user.id,
        label: label.trim() || "My EA",
        token_hash: await sha256Hex(token),
        token_prefix: token.slice(0, 8),
        risk_percent: Math.min(10, Math.max(0.1, Number(risk) || 1)),
        symbol_suffix: suffix.trim(),
      });
      if (error) throw error;
      setPlaintext(token);
      toast.success("EA token created — copy it now, it won't be shown again");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create token");
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string) => {
    await supabase.from("ea_tokens").update({ revoked: true }).eq("id", id);
    toast.success("Token revoked");
    load();
  };

  const remove = async (id: string) => {
    await supabase.from("ea_tokens").delete().eq("id", id);
    load();
  };

  return (
    <section className="mt-10">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          <Bot className="mr-2 inline h-3.5 w-3.5" />
          MetaTrader 5 Signal Feed
        </h2>
        <span className="text-xs text-muted-foreground">
          {tokens.filter((t) => !t.revoked).length} active token(s)
        </span>
      </div>

      <div className="rounded-xl border border-border/60 surface-1 p-5">
        <p className="text-sm text-muted-foreground">
          Give your Expert Advisor a private token and it can poll the live signal book over
          HTTPS. Read-only — this endpoint never places or modifies trades.
        </p>

        {/* Endpoint */}
        <div className="mt-4 space-y-1.5">
          <Label className="text-xs">Endpoint URL</Label>
          <div className="flex gap-2">
            <Input readOnly value={ENDPOINT} className="font-mono text-xs" />
            <Button variant="secondary" size="icon" onClick={() => copy(ENDPOINT, "Endpoint")}>
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Send your token in the <code className="font-mono">X-EA-Token</code> header. Optional
            query params: <code className="font-mono">status=open|all</code>,{" "}
            <code className="font-mono">since=&lt;ISO time&gt;</code>,{" "}
            <code className="font-mono">limit=100</code>.
          </p>
        </div>

        {/* Newly created token — shown once */}
        {plaintext && (
          <div className="mt-4 rounded-lg border border-gold/40 bg-gold/10 p-3">
            <p className="flex items-center gap-2 text-xs font-semibold text-gold">
              <KeyRound className="h-3.5 w-3.5" />
              Copy this token now — it is stored hashed and cannot be shown again.
            </p>
            <div className="mt-2 flex gap-2">
              <Input readOnly value={plaintext} className="font-mono text-xs" />
              <Button variant="secondary" size="icon" onClick={() => copy(plaintext, "Token")}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => setPlaintext(null)}
            >
              I've saved it
            </Button>
          </div>
        )}

        {/* Create */}
        <div className="mt-5 grid gap-4 border-t border-border/50 pt-5 sm:grid-cols-4">
          <div className="space-y-1.5 sm:col-span-2">
            <Label className="text-xs">Token label</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Risk per trade (%)</Label>
            <Input
              type="number"
              step="0.25"
              min="0.1"
              max="10"
              value={risk}
              onChange={(e) => setRisk(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Symbol suffix</Label>
            <Input
              placeholder="e.g. .m"
              value={suffix}
              onChange={(e) => setSuffix(e.target.value)}
            />
          </div>
        </div>

        <Button className="mt-4 gap-2" onClick={createToken} disabled={creating}>
          <Plus className="h-4 w-4" />
          Generate EA token
        </Button>

        {/* Existing tokens */}
        {loading ? (
          <p className="mt-5 text-xs text-muted-foreground">Loading tokens…</p>
        ) : tokens.length > 0 ? (
          <div className="mt-5 overflow-x-auto rounded-lg border border-border/50">
            <table className="w-full text-xs">
              <thead className="surface-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Label</th>
                  <th className="px-3 py-2 text-left">Token</th>
                  <th className="px-3 py-2 text-right">Risk</th>
                  <th className="px-3 py-2 text-left">Suffix</th>
                  <th className="px-3 py-2 text-left">Last used</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {tokens.map((t) => (
                  <tr key={t.id} className={cn(t.revoked && "opacity-50")}>
                    <td className="px-3 py-2 font-medium">{t.label}</td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">
                      {t.token_prefix}…{t.revoked && " (revoked)"}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {Number(t.risk_percent)}%
                    </td>
                    <td className="px-3 py-2 font-mono">{t.symbol_suffix || "—"}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {t.last_used_at ? new Date(t.last_used_at).toLocaleString() : "never"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {!t.revoked && (
                        <Button variant="ghost" size="sm" onClick={() => revoke(t.id)}>
                          Revoke
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" onClick={() => remove(t.id)}>
                        <Trash2 className="h-3.5 w-3.5 text-bear" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </section>
  );
};
