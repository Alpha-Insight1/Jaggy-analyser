-- Trade book to track signal outcomes
CREATE TABLE public.trades (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  pair TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('BUY','SELL')),
  entry NUMERIC NOT NULL,
  stop_loss NUMERIC NOT NULL,
  take_profit NUMERIC NOT NULL,
  risk_reward NUMERIC NOT NULL,
  confidence INTEGER NOT NULL,
  structure TEXT NOT NULL,
  htf_bias TEXT NOT NULL,
  confluences JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','win','loss')),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  close_price NUMERIC,
  signal_timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prevent duplicate open signals for same pair at same timestamp
CREATE UNIQUE INDEX trades_pair_signal_ts_idx ON public.trades (pair, signal_timestamp);
CREATE INDEX trades_status_idx ON public.trades (status);
CREATE INDEX trades_opened_at_idx ON public.trades (opened_at DESC);

ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;

-- Public dashboard: anyone (incl. anon) can read/write
CREATE POLICY "Anyone can view trades"
  ON public.trades FOR SELECT
  USING (true);

CREATE POLICY "Anyone can insert trades"
  ON public.trades FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Anyone can update trades"
  ON public.trades FOR UPDATE
  USING (true);

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

CREATE TRIGGER update_trades_updated_at
  BEFORE UPDATE ON public.trades
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();