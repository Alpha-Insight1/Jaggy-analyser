ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS take_profit_2 numeric,
  ADD COLUMN IF NOT EXISTS tp1_hit_at timestamptz,
  ADD COLUMN IF NOT EXISTS tp1_hit boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_trades_status_pair ON public.trades(status, pair);
CREATE INDEX IF NOT EXISTS idx_trades_confidence ON public.trades(confidence DESC);