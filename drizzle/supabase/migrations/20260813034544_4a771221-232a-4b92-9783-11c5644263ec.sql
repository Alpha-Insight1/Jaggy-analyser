CREATE TABLE public.ea_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT 'My EA',
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL DEFAULT '',
  risk_percent numeric NOT NULL DEFAULT 1.0,
  symbol_suffix text NOT NULL DEFAULT '',
  revoked boolean NOT NULL DEFAULT false,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ea_tokens TO authenticated;
GRANT ALL ON public.ea_tokens TO service_role;

ALTER TABLE public.ea_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own EA tokens"
ON public.ea_tokens FOR ALL
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_ea_tokens_updated_at
BEFORE UPDATE ON public.ea_tokens
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX ea_tokens_hash_idx ON public.ea_tokens (token_hash) WHERE revoked = false;

-- Lock down the shared signal book: public read stays, public writes go away.
DROP POLICY IF EXISTS "Anyone can insert trades" ON public.trades;
DROP POLICY IF EXISTS "Anyone can update trades" ON public.trades;
REVOKE INSERT, UPDATE ON public.trades FROM anon, authenticated;