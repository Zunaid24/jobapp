import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { companyDomain, enrichCompany } from "@/lib/decision-makers";

const ACTOR_ID = process.env.APIFY_ACTOR_ID || "0MLZsCqd5IlOf8ve3";
const DEFAULT_INPUT = { keyword: "", location: "Goa", experience: 0, maxResults: 20, sources: ["LinkedIn", "Indeed", "SimplyHired"], postedMaxDays: 7, jobType: "Any", educationLevel: "Any", skills: "" };
type ApifyJob = Record<string, unknown>;
function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`Missing environment variable: ${name}`); return value; }
function text(...values: unknown[]) { return values.find((value) => typeof value === "string" && value.trim())?.toString().trim() || ""; }
function isGoa(job: ApifyJob) { const value = text(job.location, job.title, job.summary, job.description).toLowerCase(); return /\b(goa|panaji|panjim|margao|vasco da gama|mapusa)\b/i.test(value); }
function normalize(job: ApifyJob) {
  const title = text(job.title, job.jobTitle, job.position), company = text(job.company, job.companyName, job.organization), location = text(job.location, job.jobLocation, job.city, job.workplaceType) || "Goa", description = text(job.description, job.summary, job.jobDescription, job.descriptionText), url = text(job.url, job.jobUrl, job.applyUrl, job.apply_url, job.link), posted = text(job.posted_date, job.postedDate, job.datePosted, job.createdAt), source = text(job.source, job.platform) || "Apify";
  const goa = isGoa(job);
  if (!title || !company || !goa) return null;
  const parsedDate = posted ? new Date(posted) : null;
  if (parsedDate && !Number.isNaN(parsedDate.getTime())) {
    const ageDays = (Date.now() - parsedDate.getTime()) / 86400000;
    if (ageDays < -1 || ageDays > 7) return null;
  }
  const fingerprint = text(job.id, job.jobId, url) || `${title}|${company}|${location}`;
  const id = createHash("sha256").update(fingerprint.toLowerCase()).digest("hex").slice(0, 32);
  const companyWebsite = text(job.companyWebsite, job.company_website, job.website, job.companyUrl, job.company_url) || null;
  const companyLinkedin = text(job.companyLinkedin, job.company_linkedin, job.companyLinkedinUrl, job.company_linkedin_url) || null;
  const domain = companyDomain(companyWebsite, url);
  return {
    id, title, company, location: "Goa", type: text(job.type, job.jobType, job.employmentType) || "Full-time",
    match_score: 0, description: description.slice(0, 30000), apply_url: url || null,
    contact_email: null, decision_maker_name: null, decision_maker_title: null,
    source, posted_at: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null,
    company_website: companyWebsite, company_domain: domain || null, company_linkedin_url: companyLinkedin,
    company_location: text(job.companyLocation, job.company_location, job.headquarters) || null,
    company_industry: text(job.companyIndustry, job.industry) || null,
    raw: job,
  };
}
function db() { return createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } }); }
async function runActor(input: Record<string, unknown>) {
  const token = required("APIFY_API_TOKEN");
  const response = await fetch(`https://api.apify.com/v2/actors/${encodeURIComponent(ACTOR_ID)}/run-sync-get-dataset-items?maxItems=20&maxTotalChargeUsd=0.50`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(input), cache: "no-store" });
  if (!response.ok) throw new Error(`Apify Actor failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  const data = await response.json(); return Array.isArray(data) ? data as ApifyJob[] : [];
}
export async function refreshDailyJobs() {
  const client = db(), today = new Date().toISOString().slice(0, 10);
  const { data: claimed, error: claimError } = await client.rpc("claim_daily_job_collection", { p_collection_date: today });
  if (claimError) throw new Error(`Unable to claim daily job collection: ${claimError.message}`);
  if (!claimed) { const { count } = await client.from("jobs").select("id", { count: "exact", head: true }).eq("collected_on", today); return { skipped: true, itemCount: count ?? 0 }; }
  try {
    let input: Record<string, unknown> = { ...DEFAULT_INPUT };
    if (process.env.APIFY_INPUT_JSON) input = { ...input, ...(JSON.parse(process.env.APIFY_INPUT_JSON) as Record<string, unknown>) };
    input.location = "Goa";
    input.postedMaxDays = 7;
    for (const field of ["keyword", "location", "skills"] as const) if (input[field] == null) input[field] = "";
    const items = await runActor(input);
    const normalized = items.map(normalize).filter((item): item is NonNullable<ReturnType<typeof normalize>> => Boolean(item));
    const deduped = Array.from(new Map(normalized.map((job) => [job.id, job])).values()).slice(0, 50);
    const companyRows = Array.from(new Map(deduped.map((job) => [job.company_domain || job.company.toLowerCase(), job])).values());
    const companyMap = new Map<string, string>();
    for (const job of companyRows) {
      const domain = job.company_domain || null;
      let query = client.from("companies").select("id").limit(1);
      query = domain ? query.eq("domain", domain) : query.is("domain", null).eq("name", job.company);
      const existing = await query.maybeSingle();
      let companyId = existing.data?.id;
      if (!companyId) {
        const { data, error } = await client.from("companies").insert({ name: job.company, website: job.company_website, domain, linkedin_url: job.company_linkedin_url, location: job.company_location, industry: job.company_industry, source: job.source, raw: job.raw }).select("id").single();
        if (error) throw new Error(`Unable to store company: ${error.message}`);
        companyId = data.id;
      } else {
        await client.from("companies").update({ website: job.company_website, linkedin_url: job.company_linkedin_url, location: job.company_location, industry: job.company_industry, source: job.source, raw: job.raw, updated_at: new Date().toISOString() }).eq("id", companyId);
      }
      companyMap.set(job.company_domain || job.company.toLowerCase(), companyId);
    }
    const selected = deduped.map((job) => ({ id: job.id, title: job.title, company: job.company, location: job.location, type: job.type, match_score: job.match_score, description: job.description, apply_url: job.apply_url, contact_email: null, decision_maker_name: null, decision_maker_title: null, source: job.source, posted_at: job.posted_at, collected_on: today, company_id: companyMap.get(job.company_domain || job.company.toLowerCase()) || null, raw: job.raw }));
    if (selected.length) { const { error } = await client.from("jobs").upsert(selected, { onConflict: "id" }); if (error) throw new Error(`Unable to store jobs: ${error.message}`); }

    const uniqueCompanies = Array.from(new Map(deduped.map((job) => [job.company_domain || job.company.toLowerCase(), { job, companyId: companyMap.get(job.company_domain || job.company.toLowerCase())! }])).values());
    for (const { job, companyId } of uniqueCompanies) {
      if (!companyId || !job.company_domain) continue;
      try { await enrichCompany(companyId, job.company_domain); } catch (error) { console.error(`Decision-maker enrichment failed for ${job.company}:`, error); }
    }

    await client.from("job_collection_runs").update({ status: "completed", item_count: selected.length, completed_at: new Date().toISOString(), error: null, updated_at: new Date().toISOString() }).eq("collection_date", today);
    return { skipped: false, itemCount: selected.length, goaCount: selected.length, companies: uniqueCompanies.length };
  } catch (error) {
    await client.from("job_collection_runs").update({ status: "failed", error: error instanceof Error ? error.message : "Unknown error", updated_at: new Date().toISOString() }).eq("collection_date", today); throw error;
  }
}
