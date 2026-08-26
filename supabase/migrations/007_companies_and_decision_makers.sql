create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  website text,
  domain text,
  linkedin_url text,
  location text,
  industry text,
  description text,
  source text,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(domain)
);

alter table public.jobs add column if not exists company_id uuid references public.companies(id) on delete set null;

create table if not exists public.decision_makers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  title text,
  email text,
  linkedin_url text,
  source text,
  last_enriched_at timestamptz not null default now(),
  raw jsonb,
  created_at timestamptz not null default now(),
  unique(company_id, email)
);

alter table public.companies enable row level security;
alter table public.decision_makers enable row level security;

create index if not exists jobs_company_id_idx on public.jobs(company_id);
create index if not exists decision_makers_company_id_idx on public.decision_makers(company_id);

comment on table public.companies is 'Company records extracted from recent Goa job postings and used for decision-maker enrichment.';
comment on table public.decision_makers is 'Hiring contacts enriched from company domains for job applications.';
