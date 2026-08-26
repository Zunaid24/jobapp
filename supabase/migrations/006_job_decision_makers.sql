alter table public.jobs
  add column if not exists decision_maker_name text,
  add column if not exists decision_maker_title text;

comment on column public.jobs.decision_maker_name is 'Name of the hiring manager/recruiter/decision maker when supplied by the job source';
comment on column public.jobs.decision_maker_title is 'Title of the hiring manager/recruiter/decision maker when supplied by the job source';
