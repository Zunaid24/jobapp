import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";

const ACTOR_ID = process.env.APIFY_ACTOR_ID || "0MLZsCqd5IlOf8ve3";
const DEFAULT_INPUT = { keyword: "", location: "Goa", experience: 0, maxResults: 20, sources: ["LinkedIn", "Indeed", "SimplyHired"], postedMaxDays: 0, jobType: "Any", educationLevel: "Any", skills: "" };
type ApifyJob = Record<string, unknown>;
function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`Missing environment variable: ${name}`); return value; }
function text(...values: unknown[]) { return values.find((value) => typeof value === "string" && value.trim())?.toString().trim() || ""; }
function isRemote(job: ApifyJob) { const value = text(job.location, job.workplaceType, job.jobType, job.remote, job.remoteType, job.title, job.summary, job.description).toLowerCase(); return /(^|[\s,·-])(remote|work from home|worldwide|anywhere)([\s,·-]|$)/i.test(value) || String(job.jobType || "").toLowerCase() === "remote"; }
function isGoa(job: ApifyJob) { const value = text(job.location, job.title, job.summary, job.description).toLowerCase(); return /\b(goa|panaji|panjim|margao|vasco da gama|mapusa)\b/i.test(value); }
function normalize(job: ApifyJob) {
  const title = text(job.title, job.jobTitle, job.position), company = text(job.company, job.companyName, job.organization), location = text(job.location, job.jobLocation, job.city, job.workplaceType) || "Goa", description = text(job.description, job.summary, job.jobDescription, job.descriptionText), url = text(job.url, job.jobUrl, job.applyUrl, job.apply_url, job.link), posted = text(job.posted_date, job.postedDate, job.datePosted, job.createdAt), source = text(job.source, job.platform) || "Apify";
  const goa = isGoa(job), remote = isRemote(job), targetLocation = goa ? "Goa" : remote ? "Remote" : null;
  if (!title || !company || !targetLocation) return null;
  const fingerprint = text(job.id, job.jobId, url) || `${title}|${company}|${location}`;
  const id = createHash("sha256").update(fingerprint.toLowerCase()).digest("hex").slice(0, 32);
  const parsedDate = posted ? new Date(posted) : null;
  return {
    id, title, company, location: targetLocation, type: text(job.type, job.jobType, job.employmentType) || "Full-time",
    match_score: 0, description: description.slice(0, 30000), apply_url: url || null,
    contact_email: text(job.contact_email, job.contactEmail, job.email, job.hiringManagerEmail, job.recruiterEmail) || null,
    decision_maker_name: text(job.decision_maker_name, job.decisionMakerName, job.hiringManagerName, job.recruiterName, job.contactName) || null,
    decision_maker_title: text(job.decision_maker_title, job.decisionMakerTitle, job.hiringManagerTitle, job.recruiterTitle, job.contactTitle) || null,
    source, posted_at: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null, raw: job,
  };
}
function db() { return createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } }); }
async function runActor(input: Record<string, unknown>) {
  const token = required("APIFY_API_TOKEN");
  const response = await fetch(`https://api.apify.com/v2/actors/${encodeURIComponent(ACTOR_ID)}/run-sync-get-dataset-items`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(input), cache: "no-store" });
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
    for (const field of ["keyword", "location", "skills"] as const) if (input[field] == null) input[field] = "";
    const items = await runActor(input);
    const normalized = items.map(normalize).filter((item): item is NonNullable<ReturnType<typeof normalize>> => Boolean(item));
    const deduped = Array.from(new Map(normalized.map((job) => [job.id, job])).values());
    const goa = deduped.filter((job) => job.location === "Goa").slice(0, 50);
    const selected = goa.map((job) => ({ ...job, collected_on: today }));
    if (selected.length) { const { error } = await client.from("jobs").upsert(selected, { onConflict: "id" }); if (error) throw new Error(`Unable to store jobs: ${error.message}`); }
    await client.from("job_collection_runs").update({ status: "completed", item_count: selected.length, completed_at: new Date().toISOString(), error: null, updated_at: new Date().toISOString() }).eq("collection_date", today);
    return { skipped: false, itemCount: selected.length, goaCount: goa.length };
  } catch (error) {
    await client.from("job_collection_runs").update({ status: "failed", error: error instanceof Error ? error.message : "Unknown error", updated_at: new Date().toISOString() }).eq("collection_date", today); throw error;
  }
}
