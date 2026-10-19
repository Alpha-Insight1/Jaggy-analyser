-- Signals are proprietary: only signed-in users may read the trade book.
-- (Previously this lived only in drizzle/migrations, which `supabase db push`
-- never applies, leaving the original public "Anyone can view trades" policy live.)
REVOKE ALL ON public.trades FROM anon, authenticated;
GRANT SELECT ON public.trades TO authenticated;
GRANT ALL ON public.trades TO service_role;

DROP POLICY IF EXISTS "Anyone can view trades" ON public.trades;
DROP POLICY IF EXISTS "Anyone can insert trades" ON public.trades;
DROP POLICY IF EXISTS "Anyone can update trades" ON public.trades;
DROP POLICY IF EXISTS "Signed-in users can view trades" ON public.trades;

CREATE POLICY "Signed-in users can view trades"
ON public.trades
FOR SELECT
TO authenticated
USING (true);
