create or replace function public.claim_daily_job_collection(p_collection_date date)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed boolean := false;
begin
  insert into public.job_collection_runs (collection_date, status, started_at, updated_at)
  values (p_collection_date, 'running', now(), now())
  on conflict (collection_date) do update
    set status = 'running',
        started_at = now(),
        completed_at = null,
        error = null,
        updated_at = now()
    where public.job_collection_runs.status = 'failed';

  if found then
    claimed := true;
  end if;

  return claimed;
end;
$$;

revoke all on function public.claim_daily_job_collection(date) from public;
grant execute on function public.claim_daily_job_collection(date) to service_role;
