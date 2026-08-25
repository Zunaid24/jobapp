create table if not exists public.application_tracker (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  job_id text not null,
  job_title text not null,
  company text not null,
  location text,
  status text not null default 'Applied' check (status in ('Saved','Applied','Follow-up','Interview','Rejected','Offer')),
  subject text,
  application_body text,
  applied_at timestamptz,
  last_action_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(session_id, job_id)
);

create index if not exists application_tracker_session_idx on public.application_tracker(session_id);
create index if not exists application_tracker_status_idx on public.application_tracker(status);
alter table public.application_tracker enable row level security;

create table if not exists public.daily_remote_usage (
  session_id text not null,
  usage_date date not null,
  count integer not null default 0,
  primary key (session_id, usage_date)
);
alter table public.daily_remote_usage enable row level security;
