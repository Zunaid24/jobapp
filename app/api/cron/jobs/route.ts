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
const GOA = /\b(goa|panaji|panjim|margao|mapusa|vasco(?: da gama)?|calangute|porvorim|verna|bardez|anjuna|candolim|betalbatim|mobor|taleigao)\b/i;

type SearchResult = { title: string; url: string; context: string };
type ZenserpResponse = { organic?: Array<{ title?: string; url?: string; destination?: string; description?: string; position?: number }> };

function strip(value: string) { return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
function sourceFor(url: string) {
  const lower = url.toLowerCase();
  if (/linkedin\.com\/jobs/i.test(lower)) return "linkedin";
  if (/indeed\.com/i.test(lower)) return "indeed";
  if (/foundit\.in/i.test(lower)) return "foundit";
  if (/naukri\.com/i.test(lower)) return "naukri";
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
  const cleanTitle = strip(title).replace(/\s*[|·-]\s*(LinkedIn|Indeed|Foundit|Naukri).*$/i, "");
  const loc = text.match(/([A-Z][A-Za-z0-9&.,'()\- ]{2,70})\s+(?:Goa|Panaji|Panjim|Margao|Mapusa|Vasco|Calangute|Verna|Bardez|Taleigao)\b/i);
  if (loc?.[1]) return loc[1].trim();
  const parts = cleanTitle.split(/\s+[-–—|·]\s+/).map(s => s.trim()).filter(Boolean);
  return parts.length > 1 && !/job post|salary|jobs?$/i.test(parts[1]) ? parts[1] : "Unknown company";
}

async function zenserpSearch(query: string): Promise<SearchResult[]> {
  const key = process.env.ZENSERP_API_KEY;
  if (!key) throw new Error("ZENSERP_API_KEY is not configured");
  const params = new URLSearchParams({ q: query, engine: "google", location: "Goa,India", gl: "in", hl: "en", num: "100" });
  const response = await fetch(`https://app.zenserp.com/api/v2/search?${params.toString()}`, { headers: { apikey: key, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(12000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`Zenserp ${response.status}: ${body.slice(0, 300)}`);
  const data = JSON.parse(body) as ZenserpResponse;
  return (data.organic || []).flatMap(result => {
    const url = result.destination || result.url;
    if (!url || !/^https?:\/\//i.test(url) || !sourceFor(url)) return [];
    return [{ title: strip(result.title || ""), url, context: strip(result.description || result.title || "") }];
  });
}

function extractJinaLinks(markdown: string): SearchResult[] {
  const out: SearchResult[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    for (const match of line.matchAll(/\[([^\]]{3,260})\]\((https?:\/\/[^)\s]+)\)/g)) {
      const url = match[2];
      if (!sourceFor(url)) continue;
      out.push({ title: strip(match[1]), url, context: strip(line) });
    }
  }
  return out;
}

async function jinaSearch(query: string, engine: "google" | "bing"): Promise<SearchResult[]> {
  const base = engine === "google" ? "https://www.google.com/search" : "https://www.bing.com/search";
  const target = `${base}?${new URLSearchParams({ q: query, count: "20", num: "20", hl: "en" }).toString()}`;
  const response = await fetch(`https://r.jina.ai/${target}`, { headers: { Accept: "text/markdown", "User-Agent": "jobapp-discovery/1.0" }, cache: "no-store", signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Jina ${engine} ${response.status}`);
  return extractJinaLinks(await response.text()).slice(0, 20);
}

async function publicSearch(queries: string[]): Promise<{ results: SearchResult[]; failures: string[] }> {
  const failures: string[] = [];
  const settled = await Promise.allSettled(queries.flatMap(query => [jinaSearch(query, "google"), jinaSearch(query, "bing")]));
  const results: SearchResult[] = [];
  for (const item of settled) {
    if (item.status === "fulfilled") results.push(...item.value);
    else failures.push(`public-search: ${item.reason instanceof Error ? item.reason.message : String(item.reason)}`);
  }
  return { results, failures };
}

async function discover() {
  const cutoff = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  const after = cutoff.toISOString().slice(0, 10);
  const failures: string[] = [];
  const sourceCounts: Record<string, number> = Object.fromEntries(SOURCE_KEYS.map(s => [s, 0]));

  const roleGroups = [
    ["HR Coordinator", "HR Executive", "Human Resources Officer"],
    ["HR Operations", "HR Operations Specialist", "People & Culture Executive"],
    ["HR Onboarding", "Onboarding Specialist", "Employee Lifecycle"],
    ["Recruitment Coordinator", "Talent Acquisition Specialist", "Recruitment Operations"],
    ["HRIS Analyst", "HR Administrator", "HR Assistant"],
    ["People Operations Coordinator", "HR Compliance", "HR Recruiter"],
    ["Human Resources Support Specialist", "HR Support Center Coordinator", "Senior Human Resources Generalist"],
  ];
  const siteGroups = [
    "site:linkedin.com/jobs",
    "site:indeed.com",
    "site:foundit.in",
    "site:naukri.com",
  ];
  const publicQueries = roleGroups.flatMap(group => siteGroups.map(site => `(${group.map(role => `\"${role}\"`).join(" OR ")}) ${site} (Goa OR Panaji OR Panjim OR Margao OR Mapusa OR Vasco) after:${after}`));

  let results: SearchResult[] = [];
  try {
    results = await zenserpSearch(`(${ROLES.map(role => `\"${role}\"`).join(" OR ")}) (site:linkedin.com/jobs OR site:indeed.com OR site:foundit.in OR site:naukri.com) (Goa OR Panaji OR Panjim OR Margao OR Mapusa OR Vasco) after:${after}`);
  } catch (error) {
    failures.push(`zenserp: ${error instanceof Error ? error.message : String(error)}`);
    const fallback = await publicSearch(publicQueries);
    results = fallback.results;
    failures.push(...fallback.failures);
  }

  const discovered: Array<Record<string, unknown>> = [];
  const seenUrls = new Set<string>();
  for (const result of results) {
    const source = sourceFor(result.url);
    if (!source || seenUrls.has(result.url)) continue;
    seenUrls.add(result.url);
    const text = `${result.title} ${result.context}`;
    if (!GOA.test(text)) continue;
    const age = ageHours(text);
    if (age != null && age > 360) continue;
    const postedAt = age == null ? new Date().toISOString() : new Date(Date.now() - age * 60 * 60 * 1000).toISOString();
    discovered.push({ title: result.title, company: companyFrom(result.title, result.context), location: "Goa", type: "Full-time", description: result.context.slice(0, 12000), apply_url: result.url, source, posted_at: postedAt, raw: { discovery: "public-search", title: result.title, url: result.url, description: result.context } });
    sourceCounts[source]++;
  }

  const unique = new Map<string, Record<string, unknown>>();
  for (const job of discovered) {
    const key = `${String(job.title).toLowerCase()}|${String(job.company).toLowerCase()}|goa`;
    if (!unique.has(key)) unique.set(key, job);
  }
  const jobsToImport = [...unique.values()].slice(0, 100);
  const result = await importIndiaJobs({ jobs: jobsToImport, failures, source: "public-search-multi-source" });
  return { ok: failures.length === 0, windowDays: 15, roles: ROLES, discovered: jobsToImport.length, sourceCounts, failures, result };
}

export async function runGoaDiscovery() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server configuration is missing");
  const client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: state } = await client.from("job_discovery_state").select("last_started_at,last_result").eq("id", true).maybeSingle();
  const last = state?.last_started_at ? new Date(state.last_started_at).getTime() : 0;
  const lastResult = (state?.last_result || null) as { discovered?: number } | null;
  const lastDiscovered = Number(lastResult?.discovered || 0);
  if (Date.now() - last < 6 * 60 * 60 * 1000 && lastDiscovered > 0) return { skipped: true, reason: "discovery ran within the last 6 hours" };
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
