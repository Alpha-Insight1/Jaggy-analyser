import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

export interface Account {
  id: string;
  currency: string;
  starting_balance: number;
  balance: number;
  risk_pct: number;
  auto_trade: boolean;
  max_open_positions: number;
}

export interface PaperPosition {
  id: string;
  trade_id: string;
  pair: string;
  direction: "BUY" | "SELL";
  entry: number;
  stop_loss: number;
  take_profit: number;
  risk_amount: number;
  units: number;
  status: "open" | "closed";
  realized_pnl: number | null;
  close_price: number | null;
  opened_at: string;
  closed_at: string | null;
}

interface TradeRow {
  id: string;
  pair: string;
  direction: "BUY" | "SELL";
  entry: number;
  stop_loss: number;
  take_profit: number;
  status: "open" | "win" | "loss";
  close_price: number | null;
  closed_at: string | null;
  opened_at: string;
}

const num = (v: unknown) => Number(v ?? 0);

/** Money P/L for a position at a given price. */
export const positionPnl = (p: PaperPosition, price: number) => {
  const dir = p.direction === "BUY" ? 1 : -1;
  return (price - num(p.entry)) * dir * num(p.units);
};

/**
 * Virtual capital engine. Mirrors every signal in the shared trade book into a
 * per-user paper position sized at `risk_pct` of the live balance, and settles
 * the balance when the underlying trade resolves.
 */
export const usePaperAccount = (priceMap: Record<string, number> = {}) => {
  const { user } = useAuth();
  const [account, setAccount] = useState<Account | null>(null);
  const [positions, setPositions] = useState<PaperPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    if (!user) {
      setAccount(null);
      setPositions([]);
      setLoading(false);
      return;
    }
    const [accRes, posRes] = await Promise.all([
      supabase.from("accounts").select("*").eq("user_id", user.id).maybeSingle(),
      supabase
        .from("paper_positions")
        .select("*")
        .eq("user_id", user.id)
        .order("opened_at", { ascending: false })
        .limit(500),
    ]);

    let acc = accRes.data as Account | null;
    if (!acc) {
      const { data } = await supabase
        .from("accounts")
        .insert({ user_id: user.id })
        .select()
        .single();
      acc = (data as Account) ?? null;
    }
    setAccount(acc);
    setPositions((posRes.data ?? []) as unknown as PaperPosition[]);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  /** Settle resolved trades and open new ones, then reload. */
  const sync = useCallback(async () => {
    if (!user || !account || syncing) return;
    setSyncing(true);
    try {
      const open = positions.filter((p) => p.status === "open");

      // 1. Settle positions whose underlying trade has closed.
      let balance = num(account.balance);
      if (open.length) {
        const { data: trades } = await supabase
          .from("trades")
          .select("*")
          .in(
            "id",
            open.map((p) => p.trade_id),
          );
        for (const t of (trades ?? []) as unknown as TradeRow[]) {
          if (t.status === "open") continue;
          const p = open.find((x) => x.trade_id === t.id);
          if (!p) continue;
          const exit = num(t.close_price) || (t.status === "win" ? num(t.take_profit) : num(t.stop_loss));
          const pnl = positionPnl(p, exit);
          balance += pnl;
          await supabase
            .from("paper_positions")
            .update({
              status: "closed",
              realized_pnl: Number(pnl.toFixed(2)),
              close_price: exit,
              closed_at: t.closed_at ?? new Date().toISOString(),
            })
            .eq("id", p.id)
            .eq("status", "open");
        }
      }

      // 2. Open new positions for un-mirrored active signals.
      if (account.auto_trade) {
        const { data: openTrades } = await supabase
          .from("trades")
          .select("*")
          .eq("status", "open")
          .order("opened_at", { ascending: false })
          .limit(50);
        const mirrored = new Set(positions.map((p) => p.trade_id));
        let slots = account.max_open_positions - open.length;

        for (const t of (openTrades ?? []) as unknown as TradeRow[]) {
          if (slots <= 0) break;
          if (mirrored.has(t.id)) continue;
          const riskPerUnit = Math.abs(num(t.entry) - num(t.stop_loss));
          if (!riskPerUnit) continue;
          const riskAmount = (balance * num(account.risk_pct)) / 100;
          if (riskAmount <= 0 || balance <= 0) break;
          const units = riskAmount / riskPerUnit;
          const { error } = await supabase.from("paper_positions").insert({
            user_id: user.id,
            trade_id: t.id,
            pair: t.pair,
            direction: t.direction,
            entry: t.entry,
            stop_loss: t.stop_loss,
            take_profit: t.take_profit,
            risk_amount: Number(riskAmount.toFixed(2)),
            units,
            balance_before: Number(balance.toFixed(2)),
          });
          if (!error) slots -= 1;
        }
      }

      // 3. Persist settled balance.
      if (Math.abs(balance - num(account.balance)) > 0.0001) {
        await supabase
          .from("accounts")
          .update({ balance: Number(balance.toFixed(2)) })
          .eq("id", account.id);
      }
      await load();
    } finally {
      setSyncing(false);
    }
  }, [user, account, positions, syncing, load]);

  // Re-sync whenever fresh prices land (i.e. after every scanner refresh).
  const priceKey = Object.keys(priceMap).length;
  useEffect(() => {
    if (account) sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.id, priceKey]);

  const openPositions = positions.filter((p) => p.status === "open");
  const closedPositions = positions.filter((p) => p.status === "closed");
  const unrealized = openPositions.reduce((acc, p) => {
    const px = priceMap[p.pair];
    return px == null ? acc : acc + positionPnl(p, px);
  }, 0);
  const equity = num(account?.balance) + unrealized;

  const updateAccount = async (patch: Partial<Account>) => {
    if (!account) return;
    const { data } = await supabase
      .from("accounts")
      .update(patch)
      .eq("id", account.id)
      .select()
      .single();
    if (data) setAccount(data as Account);
  };

  const resetAccount = async (deposit: number) => {
    if (!account || !user) return;
    await supabase.from("paper_positions").delete().eq("user_id", user.id);
    await supabase
      .from("accounts")
      .update({ starting_balance: deposit, balance: deposit })
      .eq("id", account.id);
    await load();
  };

  return {
    account,
    positions,
    openPositions,
    closedPositions,
    unrealized,
    equity,
    loading,
    syncing,
    updateAccount,
    resetAccount,
    reload: load,
  };
};
