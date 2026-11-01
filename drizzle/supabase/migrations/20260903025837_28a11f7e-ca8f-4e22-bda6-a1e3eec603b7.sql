ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS initial_stop_loss numeric;