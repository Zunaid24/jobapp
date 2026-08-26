import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";

const ACTOR_ID = process.env.APIFY_ACTOR_ID || "kindred_llama~job-scraper";
const DEFAULT_INPUT = {
  keyword: process.env.APIFY_KEYWORD || "HR",
  location: "",
  experience: 0,
  maxResults: 10,
  sources: ["LinkedIn", "Indeed", "SimplyHired", "Remotive", "RemoteOK", "Arbeitnow", "Jobicy"],
  postedMaxDays: 7,
  jobType: "Any",
  educationLevel: "Any",
  skills: "HR, recruiting, talent acquisition, people operations",
};

type ApifyJob = Record<string, unknown>;

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function text(...values: unknown[]) {
  return values.find((value) => typeof value === "string" && value.trim())?.toString().trim() || "";
}

function isRemote(job: ApifyJob) {
  const value = text(job.location, job.workplaceType, job.jobType, job.remote, job.remoteType, job.title, job.summary, job.description).toLowerCase();
  return /(^|[\s,·-])(remote|work from home|worldwide|anywhere)([\s,·-]|$)/i.test(value) || String(job.jobType || "").toLowerCase() === "remote";
}

function isGoa(job: ApifyJob) {
  const value = text(job.location, job.title, job.summary, job.description).toLowerCase();
  return /\b(goa|panaji|panjim|margao|vasco da gama|mapusa)\b/i.test(value);
}

function normalize(job: ApifyJob) {
  const title = text(job.title, job.jobTitle, job.position);
  const company = text(job.company, job.companyName, job.organization);
  const location = text(job.location, job.jobLocation, job.city, job.workplaceType) || "Remote";
  const description = text(job.description, job.summary, job.jobDescription, job.descriptionText);
  const url = text(job.url, job.jobUrl, job.applyUrl, job.apply_url, job.link);
  const posted = text(job.posted_date, job.postedDate, job.datePosted, job.createdAt);
  const source = text(job.source, job.platform) || "Apify";
  const remote = isRemote(job);
  const goa = isGoa(job);
  const targetLocation = goa ? "Goa" : remote ? "Remote" : null;
  if (!title || !company || !targetLocation) return null;

  const fingerprint = text(job.id, job.jobId, url) || `${title}|${company}|${location}`;
  const id = createHash("sha256").update(fingerprint.toLowerCase()).digest("hex").slice(0, 32);
  const matchScore = Number(job.match_score ?? job.matchScore ?? 0);
  const parsedDate = posted ? new Date(posted) : null;

  return {
    id,
    title,
    company,
    location: targetLocation,
    type: text(job.type, job.jobType, job.employmentType) || "Full-time",
    match_score: Number.isFinite(matchScore) ? Math.max(0, Math.min(100, Math.round(matchScore))) : 0,
    description: description.slice(0, 30000),
    apply_url: url || null,
    contact_email: text(job.contact_email, job.contactEmail, job.email) || null,
    source,
    posted_at: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null,
    raw: job,
  };
}

function db() {
  const url = required("NEXT_PUBLIC_SUPABASE_URL");
  const key = required("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function runActor(input: Record<string, unknown>) {
  const token = required("APIFY_API_TOKEN");
  const response = await fetch(`https://api.apify.com/v2/actors/${encodeURIComponent(ACTOR_ID)}/run-sync-get-dataset-items`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(input),
    cache: "no-store",
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Apify Actor failed (${response.status}): ${detail.slice(0, 500)}`);
  }
  const data = await response.json();
  return Array.isArray(data) ? data as ApifyJob[] : [];
}

export async function refreshDailyJobs() {
  const client = db();
  const today = new Date().toISOString().slice(0, 10);

  const { data: claimed, error: claimError } = await client.rpc("claim_daily_job_collection", { p_collection_date: today });
  if (claimError) throw new Error(`Unable to claim daily job collection: ${claimError.message}`);
  if (!claimed) {
    const { count } = await client.from("jobs").select("id", { count: "exact", head: true }).eq("collected_on", today);
    return { skipped: true, itemCount: count ?? 0 };
  }

  try {
    let input: Record<string, unknown> = { ...DEFAULT_INPUT };
    if (process.env.APIFY_INPUT_JSON) {
      const configured = JSON.parse(process.env.APIFY_INPUT_JSON) as Record<string, unknown>;
      input = { ...input, ...configured };
    }
    const items = await runActor(input);
    const normalized = items.map(normalize).filter((item): item is NonNullable<ReturnType<typeof normalize>> => Boolean(item));

    const deduped = Array.from(new Map(normalized.map((job) => [job.id, job])).values());
    const remote = deduped.filter((job) => job.location === "Remote").sort((a, b) => b.match_score - a.match_score).slice(0, 20);
    const goa = deduped.filter((job) => job.location === "Goa").sort((a, b) => b.match_score - a.match_score).slice(0, 50);
    const selected = [...goa, ...remote].map((job) => ({ ...job, collected_on: today }));

    if (selected.length) {
      const { error } = await client.from("jobs").upsert(selected, { onConflict: "id" });
      if (error) throw new Error(`Unable to store jobs: ${error.message}`);
    }

    await client.from("job_collection_runs").update({ status: "completed", item_count: selected.length, completed_at: new Date().toISOString(), error: null, updated_at: new Date().toISOString() }).eq("collection_date", today);
    return { skipped: false, itemCount: selected.length, goaCount: goa.length, remoteCount: remote.length };
  } catch (error) {
    await client.from("job_collection_runs").update({ status: "failed", error: error instanceof Error ? error.message : "Unknown error", updated_at: new Date().toISOString() }).eq("collection_date", today);
    throw error;
  }
}
