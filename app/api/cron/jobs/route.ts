import { NextResponse } from "next/server";
import { importIndiaJobs } from "@/lib/imported-jobs";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ROLES = [
  "HR Coordinator", "HR Executive", "Human Resources Officer", "People & Culture Executive",
  "HR Operations", "HR Operations Specialist", "HR Onboarding", "Onboarding Specialist",
  "Recruitment Coordinator", "Talent Acquisition Specialist", "Recruitment Operations",
  "HRIS Analyst", "Employee Lifecycle", "HR Administrator", "HR Assistant",
  "People Operations Coordinator", "HR Compliance", "HR Recruiter", "Human Resources Support Specialist",
  "HR Support Center Coordinator", "Senior Human Resources Generalist"
];
const SOURCE_KEYS = ["linkedin", "indeed", "foundit", "naukri"] as const;
const GOA = /\b(goa|panaji|panjim|margao|mapusa|vasco(?: da gama)?|calangute|porvorim|verna|bardez|anjuna|candolim|betalbatim|mobor|taleigao|salcette|solim)\b/i;
const BAD_TITLE = /(?:\bjobs?\s+(?:in|and|near|vacancies)|\bjob\s+vacancies|\bfor\s+hire\b|\bconsultants?\s+for\s+hire\b|\bsearch\s+results?\b|\bjobs?\s+list\b|\bvacancies\s+in\b|\bjob\s+search\b)/i;
const FOREIGN_LOCATION = /\b(?:western cape|south africa|cape town|novi,?\s*mi|michigan|tallinn|estonia|new york|united states|usa|canada|united kingdom|england|australia)\b/i;
const DETAIL_URL = /(?:linkedin\.com\/jobs\/view\/|indeed\.com\/viewjob(?:[/?]|$)|foundit\.in\/job\/|naukri\.com\/job-listings-)/i;

type SearchResult = { title: string; url: string; context: string; company?: string; location?: string; posted_at?: string; source?: string };
type GeminiInteraction = {
  output_text?: string;
  steps?: Array<{
    type?: string;
    arguments?: { queries?: string[] };
  }>;
};

function strip(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}
function sourceFor(url: string) {
  const lower = url.toLowerCase();
  if (/linkedin\.com\/jobs\/view\//i.test(lower)) return "linkedin";
  if (/indeed\.com\/viewjob(?:[/?]|$)/i.test(lower)) return "indeed";
  if (/foundit\.in\/job\//i.test(lower)) return "foundit";
  if (/naukri\.com\/job-listings-/i.test(lower)) return "naukri";
  return null;
}
function isGoa(location: string, title: string, context: string) {
  const text = `${location} ${title} ${context}`;
  return GOA.test(text) && !(FOREIGN_LOCATION.test(text) && !GOA.test(location));
}
function isUsableResult(result: SearchResult) {
  const source = sourceFor(result.url);
  if (!source || source !== result.source) return false;
  if (!DETAIL_URL.test(result.url)) return false;
  if (!result.title || BAD_TITLE.test(result.title)) return false;
  if (!result.company || /^unknown company$/i.test(result.company)) return false;
  if (!isGoa(result.location || "", result.title, result.context)) return false;
  return true;
}
function parseDate(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
function extractQueries(data: GeminiInteraction) {
  const queries: string[] = [];
  for (const step of data.steps || []) {
    if (step.type === "google_search_call" && Array.isArray(step.arguments?.queries)) queries.push(...step.arguments.queries.map(String));
  }
  return queries;
}
function dedupe(results: SearchResult[]) {
  const map = new Map<string, SearchResult>();
  for (const result of results) {
    const key = result.url.toLowerCase().replace(/[?#].*$/, "") || `${result.title}|${result.company}|${result.location}`.toLowerCase();
    if (!map.has(key)) map.set(key, result);
  }
  return [...map.values()];
}

async function geminiGoogleSearch(prompt: string) {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("GEMINI_API_KEY is not configured in this deployment");
  const model = process.env.GEMINI_JOB_SEARCH_MODEL || "gemini-3.6-flash";
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    cache: "no-store",
    signal: AbortSignal.timeout(50000),
    body: JSON.stringify({
      model,
      input: prompt,
      tools: [{ type: "google_search" }],
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: {
          type: "object",
          properties: {
            jobs: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  company: { type: "string" },
                  location: { type: "string" },
                  url: { type: "string" },
                  source: { type: "string", enum: ["linkedin", "indeed", "foundit", "naukri"] },
                  posted_at: { type: "string" },
                  summary: { type: "string" }
                },
                required: ["title", "company", "location", "url", "source", "posted_at", "summary"]
              }
            }
          },
          required: ["jobs"]
        }
      }
    })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Gemini search ${response.status}: ${body.slice(0, 800)}`);
  const data = JSON.parse(body) as GeminiInteraction;
  if (!data.output_text) throw new Error("Gemini search returned no output_text");
  const parsed = JSON.parse(data.output_text) as { jobs?: Array<Record<string, unknown>> };
  const results = (parsed.jobs || []).flatMap(job => {
    const item: SearchResult = {
      title: strip(String(job.title || "")),
      company: strip(String(job.company || "")),
      location: strip(String(job.location || "")),
      url: strip(String(job.url || "")),
      source: strip(String(job.source || "")).toLowerCase(),
      posted_at: strip(String(job.posted_at || "")),
      context: strip(String(job.summary || ""))
    };
    return /^https?:\/\//i.test(item.url) && isUsableResult(item) ? [item] : [];
  });
  return { results, queries: extractQueries(data) };
}

async function discover() {
  const cutoff = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  const failures: string[] = [];
  const sourceCounts: Record<string, number> = Object.fromEntries(SOURCE_KEYS.map(source => [source, 0]));
  const prompt = `Search the live public web for CURRENT individual job postings in Goa, India posted within the last 15 days. The candidate targets these roles and close equivalents: ${ROLES.join(", ")}. Search broadly, but prioritize LinkedIn Jobs, Indeed India, Foundit India, and Naukri. You may use other company career pages only if they are clearly relevant, but set source to one of the four requested boards only when the URL belongs to that board. Do not return search/category/listing pages, recruiter-service pages, consultants-for-hire pages, jobs-in pages, or foreign jobs. Each returned item MUST be a direct individual job-detail URL, a real company, a Goa location, and a date within the last 15 days. Do not invent URLs, companies, dates, or jobs. Return at most 30 of the most relevant unique jobs. Include the exact source URL. Search the web yourself with Google Search grounding before producing the JSON.`;
  let results: SearchResult[] = [];
  let queries: string[] = [];
  try {
    const response = await geminiGoogleSearch(prompt);
    results = response.results;
    queries = response.queries;
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  const discovered: Array<Record<string, unknown>> = [];
  for (const result of dedupe(results)) {
    const source = sourceFor(result.url);
    const posted = parseDate(result.posted_at);
    if (!source || !posted) continue;
    if (posted < cutoff || posted > new Date(Date.now() + 60 * 60 * 1000)) continue;
    const company = result.company?.trim();
    if (!company) continue;
    discovered.push({
      title: result.title,
      company,
      location: "Goa",
      type: "Full-time",
      description: result.context.slice(0, 12000),
      apply_url: result.url,
      source,
      posted_at: posted.toISOString(),
      raw: {
        discovery: "gemini-google-search",
        title: result.title,
        url: result.url,
        description: result.context,
        search_queries: queries
      }
    });
    sourceCounts[source]++;
  }

  const result = await importIndiaJobs({ jobs: discovered.slice(0, 100), failures, source: "gemini-google-search" });
  return {
    ok: failures.length === 0,
    windowDays: 15,
    roles: ROLES,
    discovered: discovered.length,
    sourceCounts,
    failures,
    searchQueries: queries,
    result
  };
}

export async function runGoaDiscovery(options?: { force?: boolean }) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server configuration is missing");
  const force = options?.force === true;
  const client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: state } = await client.from("job_discovery_state").select("last_started_at,last_result").eq("id", true).maybeSingle();
  const last = state?.last_started_at ? new Date(state.last_started_at).getTime() : 0;
  const lastResult = (state?.last_result || null) as { discovered?: number } | null;
  const lastDiscovered = Number(lastResult?.discovered || 0);
  if (!force && Date.now() - last < 6 * 60 * 60 * 1000 && lastDiscovered > 0) {
    return { skipped: true, reason: "discovery ran within the last 6 hours" };
  }
  await client.from("job_discovery_state").upsert({ id: true, last_started_at: new Date().toISOString() });
  try {
    const result = await discover();
    await client.from("job_discovery_state").update({ last_finished_at: new Date().toISOString(), last_result: result }).eq("id", true);
    return result;
  } catch (error) {
    await client.from("job_discovery_state").update({ last_finished_at: new Date().toISOString(), last_result: { error: String(error), discovered: 0 } }).eq("id", true);
    throw error;
  }
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await runGoaDiscovery());
  } catch (error) {
    console.error("Daily job collection failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Discovery failed" }, { status: 500 });
  }
}
