ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS protection_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS protected_stop_loss numeric,
  ADD COLUMN IF NOT EXISTS protected_at timestamptz;