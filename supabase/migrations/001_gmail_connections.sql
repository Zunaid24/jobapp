create table if not exists public.gmail_connections (
  session_id text primary key,
  email text,
  access_token_encrypted text not null,
  refresh_token_encrypted text,
  access_token_expires_at timestamptz not null,
  session_expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index if not exists gmail_connections_session_expires_idx
  on public.gmail_connections (session_expires_at);

alter table public.gmail_connections enable row level security;

-- The table is accessed only by the server using SUPABASE_SERVICE_ROLE_KEY.
-- No client policy is intentionally created for OAuth tokens.
