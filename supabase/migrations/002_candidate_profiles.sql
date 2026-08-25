create table if not exists public.candidate_profiles (
  session_id text primary key,
  name text not null default '',
  experience text not null default '',
  skills text not null default '',
  cv_name text,
  cv_path text,
  cv_uploaded_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.candidate_profiles enable row level security;

insert into storage.buckets (id, name, public)
values ('candidate-cvs', 'candidate-cvs', false)
on conflict (id) do nothing;

-- CVs are uploaded/read/deleted only by server routes using SUPABASE_SERVICE_ROLE_KEY.
-- No public storage policy is created.
