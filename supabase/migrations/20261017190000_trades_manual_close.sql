-- Allow signed-in users to manually close / skip paper trades
GRANT UPDATE, DELETE ON public.trades TO authenticated;

DROP POLICY IF EXISTS "Signed-in users can update trades" ON public.trades;
CREATE POLICY "Signed-in users can update trades"
ON public.trades
FOR UPDATE
TO authenticated
USING (true)
WITH CHECK (true);

DROP POLICY IF EXISTS "Signed-in users can delete open trades" ON public.trades;
CREATE POLICY "Signed-in users can delete open trades"
ON public.trades
FOR DELETE
TO authenticated
USING (status = 'open');
