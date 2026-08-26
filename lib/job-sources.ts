import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { planDailyJobSearch, rankNewJobs } from "@/lib/gemini-job-controller";

type JobvettaJob = Record<string, unknown>;
const BASE_URL = "https://api.jobvetta.com/v1";
const FALLBACK_QUERIES = ["HR Executive", "Human Resources", "HR Manager", "Recruiter", "Talent Acquisition"];

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}
function text(...values: unknown[]) {
  return values.find(v => typeof v === "string" && v.trim())?.toString().trim() || "";
}
function db() {
  return createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } });
}
function fingerprint(title: string, company: string, location: string) {
  return `${title}|${company}|${location}`.toLowerCase().replace(/\s+/g, " ").trim();
}
function normalize(job: JobvettaJob) {
  const title = text(job.title, job.normalized_title);
  const company = text(job.company, job.company_name);
  const location = text(job.location);
  const url = text(job.url, job.apply_url, job.applyUrl);
  if (!title || !company || !location || !url) return null;
  if (!/\b(goa|panaji|panjim|margao|mapusa|vasco da gama|vasco)\b/i.test(location)) return null;
  const created = Number(job.created_at);
  const posted = Number.isFinite(created) && created > 0 ? new Date(created * 1000) : null;
  const idSource = text(job.job_id, url) || fingerprint(title, company, location);
  const id = createHash("sha256").update(idSource.toLowerCase()).digest("hex").slice(0, 32);
  return {
    id,
    source_job_id: text(job.job_id) || null,
    title,
    company,
    location: "Goa",
    type: text(job.employment_type) || "Full-time",
    match_score: 0,
    description: text(job.description, job.summary).slice(0, 30000),
    apply_url: url,
    contact_email: null,
    decision_maker_name: null,
    decision_maker_title: null,
    source: "Jobvetta",
    posted_at: posted && !Number.isNaN(posted.getTime()) ? posted.toISOString() : null,
    company_website: null,
    company_domain: null,
    company_linkedin_url: null,
    company_location: text(job.company_location, job.companyLocation) || null,
    company_industry: null,
    raw: job,
  };
}

async function searchJobs(query: string, days: number) {
  const key = required("JOBVETTA_API_KEY");
  const params = new URLSearchParams({ q: query, location: "Goa", days: String(days), limit: "10" });
  const response = await fetch(`${BASE_URL}/jobs?${params.toString()}`, {
    headers: { Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Jobvetta search failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  const data = await response.json() as { jobs?: JobvettaJob[]; total?: number };
  return Array.isArray(data.jobs) ? data.jobs : [];
}

async function getDetails(jobId: string) {
  const key = required("JOBVETTA_API_KEY");
  const response = await fetch(`${BASE_URL}/jobs/${encodeURIComponent(jobId)}`, {
    headers: { Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  if (!response.ok) return null;
  return await response.json() as JobvettaJob;
}

export async function refreshDailyJobs(options: { force?: boolean } = {}) {
  const client = db();
  const today = new Date().toISOString().slice(0, 10);
  if (options.force) {
    const { error } = await client.from("job_collection_runs").delete().eq("collection_date", today);
    if (error) throw new Error(`Unable to reset daily job collection: ${error.message}`);
  }

  const { data: claimed, error: claimError } = await client.rpc("claim_daily_job_collection", { p_collection_date: today });
  if (claimError) throw new Error(`Unable to claim daily job collection: ${claimError.message}`);
  if (!claimed) {
    const { count } = await client.from("jobs").select("id", { count: "exact", head: true }).eq("collected_on", today);
    return { skipped: true, itemCount: count ?? 0 };
  }

  try {
    const plan = await planDailyJobSearch();
    const queries = Array.from(new Set((plan.roleQueries?.length ? plan.roleQueries : FALLBACK_QUERIES).map(x => String(x).trim()).filter(Boolean))).slice(0, 5);
    while (queries.length < 5) queries.push(FALLBACK_QUERIES[queries.length]);

    const { data: history, error: historyError } = await client.from("jobs").select("id,title,company,location,apply_url").order("collected_on", { ascending: false }).limit(2000);
    if (historyError) throw new Error(`Unable to load job history: ${historyError.message}`);
    const seenIds = new Set((history || []).map(j => j.id));
    const seenFingerprints = new Set((history || []).map(j => fingerprint(j.title || "", j.company || "", j.location || "")));

    // Five searches × ten results = at most 50 search calls/results per day is not
    // the limit: Jobvetta's free tier is 50 HTTP calls/day. We therefore use five
    // searches and spend the remaining budget only on details for the strongest
    // candidates.
    const searchResults = await Promise.all(queries.map(q => searchJobs(q, Math.min(2, Math.max(1, plan.postedMaxDays || 2)))));
    const normalized = searchResults.flat().map(normalize).filter((x): x is NonNullable<ReturnType<typeof normalize>> => Boolean(x));
    const unique = Array.from(new Map(normalized.map(job => [job.source_job_id || job.id, job])).values())
      .filter(job => !seenIds.has(job.id) && !seenFingerprints.has(fingerprint(job.title, job.company, job.location)))
      .slice(0, 40);

    // Enrich only the strongest candidates, keeping the daily API usage comfortably
    // below the 50-call free allowance: 5 searches + up to 20 details.
    const preselected = unique.sort((a, b) => {
      const score = (title: string) => /\b(hr|human resources|recruit|recruitment|talent acquisition|people)\b/i.test(title) ? 100 : 50;
      return score(b.title) - score(a.title);
    }).slice(0, 20);
    const details = await Promise.all(preselected.map(j => j.source_job_id ? getDetails(j.source_job_id) : Promise.resolve(null)));
    const enriched = preselected.map((job, index) => details[index] ? { ...job, ...normalize({ ...job.raw, ...details[index] }) } : job).filter(Boolean) as NonNullable<ReturnType<typeof normalize>>[];

    const ranked = await rankNewJobs(enriched);
    const rankMap = new Map(ranked.map(r => [r.id, r]));
    const selected = enriched
      .filter(job => { const r = rankMap.get(job.id); return r?.decision === "KEEP" && r.score >= 70; })
      .sort((a, b) => (rankMap.get(b.id)?.score || 0) - (rankMap.get(a.id)?.score || 0))
      .slice(0, 50)
      .map(job => ({ ...job, match_score: rankMap.get(job.id)?.score || job.match_score }));

    const companyRows = Array.from(new Map(selected.map(j => [j.company.toLowerCase(), j])).values());
    const companyMap = new Map<string, string>();
    for (const job of companyRows) {
      const existing = await client.from("companies").select("id").eq("name", job.company).maybeSingle();
      let companyId = existing.data?.id;
      if (!companyId) {
        const { data, error } = await client.from("companies").insert({ name: job.company, website: job.company_website, domain: job.company_domain, linkedin_url: job.company_linkedin_url, location: job.company_location, industry: job.company_industry, source: job.source, raw: job.raw }).select("id").single();
        if (error) throw new Error(`Unable to store company: ${error.message}`);
        companyId = data.id;
      }
      companyMap.set(job.company.toLowerCase(), companyId);
    }

    if (selected.length) {
      const rows = selected.map(job => ({ id: job.id, title: job.title, company: job.company, location: job.location, type: job.type, match_score: job.match_score, description: job.description, apply_url: job.apply_url, contact_email: null, decision_maker_name: null, decision_maker_title: null, source: job.source, posted_at: job.posted_at, collected_on: today, company_id: companyMap.get(job.company.toLowerCase()) || null, raw: job.raw }));
      const { error } = await client.from("jobs").upsert(rows, { onConflict: "id" });
      if (error) throw new Error(`Unable to store jobs: ${error.message}`);
    }

    await client.from("job_collection_runs").update({ status: "completed", item_count: selected.length, completed_at: new Date().toISOString(), error: null, updated_at: new Date().toISOString() }).eq("collection_date", today);
    return { skipped: false, itemCount: selected.length, goaCount: selected.length, companies: companyRows.length, decisionMakers: 0, seenExcluded: seenIds.size, jobvettaCandidates: normalized.length, aiAccepted: selected.length, source: "Jobvetta", searchQueries: queries };
  } catch (error) {
    await client.from("job_collection_runs").update({ status: "failed", error: error instanceof Error ? error.message : "Unknown error", updated_at: new Date().toISOString() }).eq("collection_date", today);
    throw error;
  }
}
