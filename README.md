# Jaggy Analyser

Swing-trading signal dashboard using Smart Money Concepts (BOS/CHoCH, Order Blocks, FVG) on the 4H chart with Daily bias. Vite + React + TypeScript + shadcn/ui, backed by Supabase (Auth, Postgres, Edge Functions).

## Local development

```bash
cp .env.example .env      # fill in your Supabase URL + publishable key
npm install
npm run dev               # http://localhost:8080
```

Tidy-up on first install: `npm uninstall lovable-tagger` (no longer used) to refresh `package-lock.json`.

## Deploy

### 1. Backend (Supabase)
Add repository **secrets** `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` and **variable** `SUPABASE_PROJECT_REF`, then run the *Deploy Supabase backend* workflow (or run `supabase db push` and `supabase functions deploy forex-analysis mt5-signals` locally).

Function secrets (Supabase → Edge Functions → Secrets), only needed for push notifications: `LOVABLE_API_KEY`, `FIREBASE_MESSAGING_API_KEY`. Without them, push is skipped and everything else works.

In Supabase → Authentication → URL Configuration set **Site URL** and **Redirect URLs** to your GitHub Pages URL. To make the app invite-only, disable "Allow new users to sign up" and set `VITE_ALLOW_SIGNUP=false`.

### 2. Frontend (GitHub Pages)
1. Repo → Settings → Pages → **Source: GitHub Actions**.
2. Repo → Settings → Secrets and variables → Actions → **Variables**: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (optional: `VITE_ALLOW_SIGNUP`, the four `VITE_LOVABLE_CONNECTOR_FIREBASE_MESSAGING_*`, and `VITE_BASE_PATH=/` for a custom domain).
3. Push to `main`. The *Deploy to GitHub Pages* workflow builds and publishes to `https://<user>.github.io/<repo>/`.

## Security model
- `trades` is readable only by signed-in users (RLS); writes happen only through the service role in edge functions.
- `forex-analysis` requires and re-validates a user JWT. `mt5-signals` is authenticated by a hashed per-user EA token (JWT gateway check intentionally off, see `supabase/config.toml`).
- Never commit `.env` or put the service-role key in the frontend.

## Disclaimer
Educational analysis only. Not financial advice.
