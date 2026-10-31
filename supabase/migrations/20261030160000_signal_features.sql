-- Feature vectors for expectancy research (grade, model, session, sweep, etc.)
create table if not exists public.signal_features (
  id uuid primary key default gen_random_uuid(),
  trade_id uuid references public.trades(id) on delete set null,
  pair text not null,
  direction text not null,
  grade text,
  entry_model text,
  signal_style text,
  structure_tf text,
  entry_tf text,
  confidence numeric,
  risk_reward numeric,
  htf_bias text,
  structure text,
  has_sweep boolean default false,
  session_tag text,
  confluences jsonb,
  confidence_breakdown jsonb,
  created_at timestamptz not null default now()
);

create index if not exists signal_features_pair_idx on public.signal_features (pair);
create index if not exists signal_features_grade_idx on public.signal_features (grade);
create index if not exists signal_features_model_idx on public.signal_features (entry_model);
create index if not exists signal_features_created_idx on public.signal_features (created_at desc);

alter table public.signal_features enable row level security;

-- Readable by authenticated users; writes only via service role (edge functions)
create policy "signal_features_select_auth"
  on public.signal_features for select
  to authenticated
  using (true);
