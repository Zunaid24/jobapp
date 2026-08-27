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
const BAD_TITLE = /(?:\bjobs?\s+(?:in|and|near|vacancies)|\bjob\s+vacancies|\bfor\s+hire\b|\bconsultants?\s+for\s+hire\b|\bsearch\s+results?\b|\bjobs?\s+list\b|\bvacancies\s+in\b)/i;
const FOREIGN_LOCATION = /\b(?:western cape|south africa|cape town|novi,?\s*mi|michigan|tallinn|estonia|new york,?\s*(?:ny|united states)?|united states|usa|canada|united kingdom|england|australia)\b/i;

type SearchResult = { title: string; url: string; context: string };
type ZenserpResponse = { organic?: Array<{ title?: string; url?: string; destination?: string; description?: string }> };

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
function ageHours(value: string) {
  const t = value.toLowerCase();
  if (/\bjust now\b|\btoday\b|\bhours? ago\b|\b1\s*hour\b/.test(t)) return 1;
  const m = t.match(/(\d+)\s*(day|week|month)s?\s*ago/);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2].startsWith("week") ? n * 168 : m[2].startsWith("month") ? n * 720 : n * 24;
}
function companyFrom(title: string, text: string) {
  const companyMarker = text.match(/(?:company|employer)\s*[:\-]\s*([^|•\n]{2,100})/i);
  if (companyMarker?.[1]) return companyMarker[1].trim().replace(/[,.]$/, "");
  const cleanTitle = strip(title).replace(/\s*[|·-]\s*(LinkedIn|Indeed|Foundit|Naukri).*$/i, "");
  const parts = cleanTitle.split(/\s+[-–—|·]\s+/).map(s => s.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const candidate = parts[i].replace(/[,.]$/, "");
    if (!candidate || GOA.test(candidate) || /^(india|goa|panaji|panjim|margao|mapusa|vasco|taleigao|bardez)$/i.test(candidate)) continue;
    if (/^(hr|human resources|recruitment|talent acquisition|jobs?|job vacancies?)$/i.test(candidate)) continue;
    if (candidate.length >= 3) return candidate;
  }
  const loc = text.match(/\b([A-Z][A-Za-z0-9&.'()\- ]{2,80})\s+(?:Goa|Panaji|Panjim|Margao|Mapusa|Vasco|Calangute|Verna|Bardez|Taleigao|Salcette)\b/i);
  if (loc?.[1] && !BAD_TITLE.test(loc[1])) return loc[1].trim().replace(/[,.]$/, "");
  return "Unknown company";
}
function isUsableResult(result: SearchResult) {
  const source = sourceFor(result.url);
  if (!source) return false;
  const text = `${strip(result.title)} ${strip(result.context)}`;
  if (!strip(result.title) || BAD_TITLE.test(result.title) || !GOA.test(text)) return false;
  if (FOREIGN_LOCATION.test(text) && !/goa|panaji|panjim|margao|mapusa|vasco|verna|bardez|taleigao|salcette/i.test(text)) return false;
  return true;
}

async function zenserpSearch(query: string, engine: "google" | "bing" = "google"): Promise<SearchResult[]> {
  const key = process.env.ZENSERP_API_KEY?.trim();
  if (!key) throw new Error("ZENSERP_API_KEY is not configured in this deployment");
  const params = new URLSearchParams({ q: query, engine, gl: "in", hl: "en", num: "100" });
  const response = await fetch(`https://app.zenserp.com/api/v2/search?${params.toString()}`, { headers: { apikey: key, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(10000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`Zenserp ${engine} ${response.status}: ${body.slice(0, 300)}`);
  const data = JSON.parse(body) as ZenserpResponse;
  return (data.organic || []).flatMap(result => {
    const url = result.destination || result.url;
    if (!url || !/^https?:\/\//i.test(url)) return [];
    const item = { title: strip(result.title || ""), url, context: strip(result.description || result.title || "") };
    return isUsableResult(item) ? [item] : [];
  });
}

async function discover() {
  const cutoff = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  const after = cutoff.toISOString().slice(0, 10);
  const failures: string[] = [];
  const sourceCounts: Record<string, number> = Object.fromEntries(SOURCE_KEYS.map(s => [s, 0]));

  // Keep the SERP query intentionally simple: complex boolean/site expressions were producing
  // intermittent Zenserp 500s. We constrain by the exact board detail URL domains afterward.
  const query = `("HR Coordinator" OR "HR Executive" OR "Human Resources" OR "Talent Acquisition" OR "Recruitment" OR "HR Operations" OR "HRIS") Goa India jobs after:${after}`;
  let results: SearchResult[] = [];
  try {
    results = await zenserpSearch(query, "google");
    if (results.length === 0) {
      try { results = await zenserpSearch(query, "bing"); }
      catch (error) { failures.push(`zenserp-bing: ${error instanceof Error ? error.message : String(error)}`); }
    }
  } catch (error) {
    failures.push(`zenserp-google: ${error instanceof Error ? error.message : String(error)}`);
    try { results = await zenserpSearch(query, "bing"); }
    catch (error) { failures.push(`zenserp-bing: ${error instanceof Error ? error.message : String(error)}`); }
  }

  const discovered: Array<Record<string, unknown>> = [];
  const seenUrls = new Set<string>();
  for (const result of results) {
    const source = sourceFor(result.url);
    if (!source || seenUrls.has(result.url)) continue;
    seenUrls.add(result.url);
    const text = `${result.title} ${result.context}`;
    const age = ageHours(text);
    if (age != null && age > 360) continue;
    const postedAt = age == null ? new Date().toISOString() : new Date(Date.now() - age * 60 * 60 * 1000).toISOString();
    const company = companyFrom(result.title, result.context);
    if (company === "Unknown company") continue;
    discovered.push({ title: result.title, company, location: "Goa", type: "Full-time", description: result.context.slice(0, 12000), apply_url: result.url, source, posted_at: postedAt, raw: { discovery: "zenserp", title: result.title, url: result.url, description: result.context } });
    sourceCounts[source]++;
  }

  const unique = new Map<string, Record<string, unknown>>();
  for (const job of discovered) {
    const key = `${String(job.title).toLowerCase()}|${String(job.company).toLowerCase()}|goa`;
    if (!unique.has(key)) unique.set(key, job);
  }
  const jobsToImport = [...unique.values()].slice(0, 100);
  const result = await importIndiaJobs({ jobs: jobsToImport, failures, source: "zenserp-multi-source" });
  return { ok: failures.length === 0, windowDays: 15, roles: ROLES, discovered: jobsToImport.length, sourceCounts, failures, result };
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
  if (!force && Date.now() - last < 6 * 60 * 60 * 1000 && lastDiscovered > 0) return { skipped: true, reason: "discovery ran within the last 6 hours" };
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
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { return NextResponse.json(await runGoaDiscovery()); }
  catch (error) { console.error("Daily job collection failed", error); return NextResponse.json({ error: error instanceof Error ? error.message : "Discovery failed" }, { status: 500 }); }
}
