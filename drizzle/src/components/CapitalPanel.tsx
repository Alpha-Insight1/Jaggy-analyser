import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { usePaperAccount, positionPnl } from "@/hooks/usePaperAccount";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Wallet, RotateCcw, LogIn } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface Props {
  priceMap?: Record<string, number>;
}

const money = (v: number, ccy = "USD") =>
  `${ccy === "USD" ? "$" : ""}${v.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export const CapitalPanel = ({ priceMap = {} }: Props) => {
  const { user } = useAuth();
  const {
    account,
    openPositions,
    closedPositions,
    unrealized,
    equity,
    loading,
    updateAccount,
    resetAccount,
  } = usePaperAccount(priceMap);
  const [deposit, setDeposit] = useState("100");

  if (!user) {
    return (
      <section className="mt-10">
        <div className="flex flex-col items-center gap-3 rounded-xl border border-border/60 surface-1 p-8 text-center">
          <Wallet className="h-6 w-6 text-gold" />
          <p className="font-medium">Managed paper capital</p>
          <p className="max-w-md text-sm text-muted-foreground">
            Sign in to fund a virtual account. Every signal the engine fires is auto-sized
            against your balance so you can see exactly what the strategy would have done to
            your money.
          </p>
          <Button asChild size="sm" className="gap-2">
            <Link to="/auth">
              <LogIn className="h-4 w-4" />
              Sign in / Create account
            </Link>
          </Button>
        </div>
      </section>
    );
  }

  if (loading || !account) {
    return (
      <section className="mt-10">
        <div className="rounded-xl border border-border/60 surface-1 p-8 text-center text-sm text-muted-foreground">
          Loading your account…
        </div>
      </section>
    );
  }

  const realized = closedPositions.reduce((a, p) => a + Number(p.realized_pnl ?? 0), 0);
  const growth =
    Number(account.starting_balance) > 0
      ? ((equity - Number(account.starting_balance)) / Number(account.starting_balance)) * 100
      : 0;
  const riskPerTrade = (Number(account.balance) * Number(account.risk_pct)) / 100;

  return (
    <section className="mt-10">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          <Wallet className="mr-2 inline h-3.5 w-3.5" />
          Managed Capital (Paper)
        </h2>
        <span className="text-xs text-muted-foreground">
          {openPositions.length} live · {closedPositions.length} settled
        </span>
      </div>

      <div className="rounded-xl border border-border/60 surface-1 p-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Equity" value={money(equity, account.currency)} tone={growth >= 0 ? "bull" : "bear"} />
          <Tile label="Cash balance" value={money(Number(account.balance), account.currency)} />
          <Tile
            label="Open P/L"
            value={`${unrealized >= 0 ? "+" : ""}${money(unrealized, account.currency)}`}
            tone={unrealized >= 0 ? "bull" : "bear"}
          />
          <Tile
            label="Realized P/L"
            value={`${realized >= 0 ? "+" : ""}${money(realized, account.currency)}`}
            tone={realized >= 0 ? "bull" : "bear"}
          />
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          Deposited {money(Number(account.starting_balance), account.currency)} ·{" "}
          <span className={growth >= 0 ? "text-bull" : "text-bear"}>
            {growth >= 0 ? "+" : ""}
            {growth.toFixed(1)}%
          </span>{" "}
          · risking {money(riskPerTrade, account.currency)} ({Number(account.risk_pct)}%) per trade
        </p>

        {/* Controls */}
        <div className="mt-5 grid gap-4 border-t border-border/50 pt-5 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Risk per trade (%)</Label>
            <Input
              type="number"
              step="0.25"
              min="0.1"
              max="10"
              defaultValue={Number(account.risk_pct)}
              onBlur={(e) => {
                const v = Math.min(10, Math.max(0.1, Number(e.target.value)));
                if (v !== Number(account.risk_pct)) updateAccount({ risk_pct: v });
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Max open positions</Label>
            <Input
              type="number"
              min="1"
              max="20"
              defaultValue={account.max_open_positions}
              onBlur={(e) => {
                const v = Math.min(20, Math.max(1, Math.round(Number(e.target.value))));
                if (v !== account.max_open_positions) updateAccount({ max_open_positions: v });
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Deposit / reset balance</Label>
            <div className="flex gap-2">
              <Input
                type="number"
                min="1"
                value={deposit}
                onChange={(e) => setDeposit(e.target.value)}
              />
              <Button
                variant="secondary"
                size="icon"
                title="Reset account to this deposit"
                onClick={async () => {
                  const v = Number(deposit);
                  if (!v || v <= 0) return;
                  await resetAccount(v);
                  toast.success(`Account reset to ${money(v, account.currency)}`);
                }}
              >
                <RotateCcw className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between rounded-lg surface-2 px-3 py-2">
          <div>
            <p className="text-xs font-medium">Auto-trade signals</p>
            <p className="text-[11px] text-muted-foreground">
              Automatically size and take every new signal against your balance.
            </p>
          </div>
          <Switch
            checked={account.auto_trade}
            onCheckedChange={(v) => updateAccount({ auto_trade: v })}
          />
        </div>

        {/* Positions */}
        {openPositions.length > 0 && (
          <div className="mt-5 overflow-x-auto rounded-lg border border-border/50">
            <table className="w-full text-xs">
              <thead className="surface-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Pair</th>
                  <th className="px-3 py-2 text-left">Side</th>
                  <th className="px-3 py-2 text-right">Entry</th>
                  <th className="px-3 py-2 text-right">Risked</th>
                  <th className="px-3 py-2 text-right">P/L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40 font-mono tabular-nums">
                {openPositions.map((p) => {
                  const px = priceMap[p.pair];
                  const pnl = px == null ? null : positionPnl(p, px);
                  return (
                    <tr key={p.id}>
                      <td className="px-3 py-2 font-semibold">{p.pair}</td>
                      <td
                        className={cn(
                          "px-3 py-2 font-bold",
                          p.direction === "BUY" ? "text-bull" : "text-bear",
                        )}
                      >
                        {p.direction}
                      </td>
                      <td className="px-3 py-2 text-right">{p.entry}</td>
                      <td className="px-3 py-2 text-right text-muted-foreground">
                        {money(Number(p.risk_amount), account.currency)}
                      </td>
                      <td
                        className={cn(
                          "px-3 py-2 text-right font-semibold",
                          pnl == null ? "text-muted-foreground" : pnl >= 0 ? "text-bull" : "text-bear",
                        )}
                      >
                        {pnl == null ? "—" : `${pnl >= 0 ? "+" : ""}${money(pnl, account.currency)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
};

const Tile = ({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "bull" | "bear";
}) => (
  <div className="rounded-lg surface-2 p-3">
    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
    <p
      className={cn(
        "mt-1 font-mono text-base font-bold tabular-nums",
        tone === "bull" && "text-bull",
        tone === "bear" && "text-bear",
      )}
    >
      {value}
    </p>
  </div>
);
