import { createClient } from "@supabase/supabase-js";
import { rankNewJobs } from "@/lib/gemini-job-controller";
import { createHash } from "crypto";

type IncomingJob = Record<string, unknown>;
function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`Missing environment variable: ${name}`); return value; }
function text(...values: unknown[]) { return values.find(v => typeof v === "string" && v.trim())?.toString().trim() || ""; }
function db() { return createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } }); }
function fingerprint(title: string, company: string, location: string) { return `${title}|${company}|${location}`.toLowerCase().replace(/\s+/g, " ").trim(); }
function normalize(row: IncomingJob) {
  const title = text(row.title), company = text(row.company), location = text(row.location), url = text(row.apply_url, row.job_url, row.url);
  if (!title || !company || !location || !url || !/\b(goa|panaji|panjim|margao|mapusa|vasco(?: da gama)?)\b/i.test(location)) return null;
  const source = text(row.source).toLowerCase();
  if (!["linkedin", "indeed"].includes(source)) return null;
  const posted = text(row.posted_at); if (!posted) return null;
  const postedDate = new Date(posted); if (Number.isNaN(postedDate.getTime())) return null;
  if (Date.now() - postedDate.getTime() > 72 * 60 * 60 * 1000 || postedDate.getTime() > Date.now() + 60 * 60 * 1000) return null;
  const id = text(row.id, row.source_job_id) || createHash("sha256").update(url.toLowerCase()).digest("hex").slice(0, 32);
  return { id, source_job_id: text(row.source_job_id) || id, title, company, location: "Goa", type: text(row.type) || "Full-time", description: text(row.description).slice(0, 30000), apply_url: url, contact_email: null, decision_maker_name: null, decision_maker_title: null, source, posted_at: postedDate.toISOString(), company_website: null, company_domain: null, company_linkedin_url: null, company_location: location, company_industry: null, raw: row.raw ?? row };
}

export async function importIndiaJobs(input: { jobs?: IncomingJob[]; failures?: string[]; source?: string }) {
  const client = db();
  const incoming = (input.jobs || []).map(normalize).filter((x): x is NonNullable<ReturnType<typeof normalize>> => Boolean(x));
  const unique = Array.from(new Map(incoming.map(job => [job.id, job])).values());
  const { data: history, error } = await client.from("jobs").select("id,title,company,location,apply_url").order("collected_on", { ascending: false }).limit(5000);
  if (error) throw new Error(`Unable to load job history: ${error.message}`);
  const seenIds = new Set((history || []).map(j => j.id));
  const seenFingerprints = new Set((history || []).map(j => fingerprint(j.title || "", j.company || "", j.location || "")));
  const fresh = unique.filter(job => !seenIds.has(job.id) && !seenFingerprints.has(fingerprint(job.title, job.company, job.location)));
  if (!fresh.length) return { received: unique.length, fresh: 0, accepted: 0, excludedSeen: unique.length, source: input.source || "india-jobspy" };
  const ranked = await rankNewJobs(fresh.slice(0, 100));
  const rankMap = new Map(ranked.map(r => [r.id, r]));
  // Ranking is advisory: the source/date/location gates above are authoritative. Select the best relevant roles, with a lower threshold so a transient AI over-rejection cannot erase genuine fresh jobs.
  const selected = fresh.filter(job => { const result = rankMap.get(job.id); return result?.decision === "KEEP" && result.score >= 55; }).sort((a, b) => (rankMap.get(b.id)?.score || 0) - (rankMap.get(a.id)?.score || 0)).slice(0, 50).map(job => ({ ...job, match_score: rankMap.get(job.id)?.score || 0 }));
  const companyMap = new Map<string, string>();
  for (const job of selected) {
    const key = job.company.toLowerCase();
    if (companyMap.has(key)) continue;
    const existing = await client.from("companies").select("id").eq("name", job.company).maybeSingle();
    if (existing.data?.id) { companyMap.set(key, existing.data.id); continue; }
    const inserted = await client.from("companies").insert({ name: job.company, website: job.company_website, domain: job.company_domain, linkedin_url: job.company_linkedin_url, location: job.company_location, industry: job.company_industry, source: job.source, raw: job.raw }).select("id").single();
    if (inserted.error) throw new Error(`Unable to store company ${job.company}: ${inserted.error.message}`);
    companyMap.set(key, inserted.data.id);
  }
  if (selected.length) {
    const rows = selected.map(job => ({ id: job.id, title: job.title, company: job.company, location: job.location, type: job.type, match_score: job.match_score, description: job.description, apply_url: job.apply_url, contact_email: null, decision_maker_name: null, decision_maker_title: null, source: job.source, posted_at: job.posted_at, collected_on: new Date().toISOString().slice(0, 10), company_id: companyMap.get(job.company.toLowerCase()) || null, raw: job.raw }));
    const stored = await client.from("jobs").upsert(rows, { onConflict: "id" });
    if (stored.error) throw new Error(`Unable to store imported jobs: ${stored.error.message}`);
  }
  return { received: unique.length, fresh: fresh.length, accepted: selected.length, rejectedByAi: fresh.length - selected.length, source: input.source || "india-jobspy", failures: input.failures || [] };
}
