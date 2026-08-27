import { NextResponse } from "next/server";
import { importIndiaJobs } from "@/lib/imported-jobs";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ROLES = [
  "HR Coordinator","HR Executive","Human Resources Officer","People & Culture Executive",
  "HR Operations","HR Operations Specialist","HR Onboarding","Onboarding Specialist",
  "Recruitment Coordinator","Talent Acquisition Specialist","Recruitment Operations",
  "HRIS Analyst","Employee Lifecycle","HR Administrator","HR Assistant",
  "People Operations Coordinator","HR Compliance","HR Recruiter","Human Resources Support Specialist",
  "HR Support Center Coordinator","Senior Human Resources Generalist"
];

const SOURCES = [
  { key: "linkedin", domains: ["linkedin.com/jobs/", "linkedin.com/jobs/view"] },
  { key: "indeed", domains: ["indeed.com/viewjob", "in.indeed.com/"] },
  { key: "foundit", domains: ["foundit.in/"] },
  { key: "naukri", domains: ["naukri.com/"] },
] as const;

const GOA = /\b(goa|panaji|panjim|margao|mapusa|vasco(?: da gama)?|calangute|porvorim|verna|bardez|anjuna|candolim|betalbatim|mobor|taleigao)\b/i;
const ROLE_GROUPS = [
  ["HR Coordinator", "HR Executive", "Human Resources Officer", "People & Culture Executive", "HR Administrator", "HR Assistant"],
  ["HR Operations", "HR Operations Specialist", "HR Onboarding", "Onboarding Specialist", "Recruitment Coordinator", "Talent Acquisition Specialist", "Recruitment Operations", "HR Recruiter", "HRIS Analyst"],
];

type SearchResult = { title: string; url: string; context: string };

function decode(value: string) {
  let v = value;
  for (let i = 0; i < 3; i++) { try { v = decodeURIComponent(v); } catch { break; } }
  return v.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&#x2F;/gi, "/").replace(/&#x3D;/gi, "=").replace(/&nbsp;/g, " ");
}
function strip(value: string) { return decode(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()); }
function absoluteUrl(href: string) {
  const h = decode(href.trim());
  if (/^https?:\/\//i.test(h)) {
    try {
      const u = new URL(h);
      const target = u.searchParams.get("url") || u.searchParams.get("q") || u.searchParams.get("uddg");
      return target && /^https?:\/\//i.test(target) ? decode(target) : h;
    } catch { return h; }
  }
  if (h.startsWith("/url?")) {
    try {
      const u = new URL(`https://www.google.com${h}`);
      for (const key of ["q", "url"]) {
        const target = u.searchParams.get(key);
        if (target && /^https?:\/\//i.test(target)) return decode(target);
      }
    } catch { /* ignore */ }
  }
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
function sourceFor(url: string) {
  const lower = url.toLowerCase();
  return SOURCES.find(s => s.domains.some(d => lower.includes(d)))?.key ?? null;
}
function parseJinaSearch(markdown: string, sourceKey: string): SearchResult[] {
  const out: SearchResult[] = [];
  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const links = [...line.matchAll(/\[([^\]]{3,220})\]\((https?:\/\/[^)\s]+)\)/g)];
    for (const match of links) {
      const url = absoluteUrl(match[2]);
      if (!url || sourceFor(url) !== sourceKey) continue;
      const title = strip(match[1]);
      if (!title || /^(apply|click|view|read more|jobs)$/i.test(title)) continue;
      const context = strip(lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 7)).join(" "));
      if (!out.some(x => x.url === url)) out.push({ title, url, context });
    }
  }
  return out.slice(0, 20);
}

async function jinaSearch(query: string, sourceKey: string) {
  const target = `https://www.google.com/search?hl=en&num=10&q=${encodeURIComponent(query)}`;
  const response = await fetch(`https://r.jina.ai/${target}`, {
    headers: { Accept: "text/markdown", "User-Agent": "jobapp-discovery/1.0" },
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`Jina reader ${response.status}`);
  return parseJinaSearch(await response.text(), sourceKey);
}

async function directSearch(query: string, source: (typeof SOURCES)[number]) {
  const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36", "Accept-Language": "en-US,en;q=0.9" };
  try {
    const google = await fetch(`https://www.google.com/search?gbv=1&hl=en&num=10&q=${encodeURIComponent(query)}`, { headers, cache: "no-store", signal: AbortSignal.timeout(7000) });
    if (google.ok) {
      const html = await google.text();
      const out: SearchResult[] = [];
      const h3Re = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
      let match: RegExpExecArray | null;
      while ((match = h3Re.exec(html)) !== null) {
        const block = html.slice(Math.max(0, match.index - 12000), Math.min(html.length, match.index + 12000));
        const anchors = [...block.matchAll(/<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>/gi)];
        const url = anchors.map(a => absoluteUrl(a[1])).find(u => !!u && source.domains.some(d => u.toLowerCase().includes(d))) ?? null;
        if (url) out.push({ title: strip(match[1]), url, context: strip(block) });
      }
      if (out.length) return out.slice(0, 20);
    }
  } catch { /* fallback below */ }
  return [];
}

async function discover() {
  const cutoff = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  const after = cutoff.toISOString().slice(0, 10);
  const failures: string[] = [];
  const discovered: Array<Record<string, unknown>> = [];
  const sourceCounts: Record<string, number> = Object.fromEntries(SOURCES.map(s => [s.key, 0]));

  // The previous implementation made 84 direct search-engine requests from Vercel.
  // That was brittle and routinely failed at the network layer. Use Jina Reader as a
  // public fetch/search bridge first, with only 8 bounded queries, then direct search
  // as a fallback. Jina's Reader is explicitly designed to fetch public URLs and can
  // render JS-heavy pages through its browser engine. See https://jina.ai/reader/.
  const jobs = SOURCES.flatMap(source => ROLE_GROUPS.map(group => ({
    source,
    query: `site:${source.domains[0]} (${group.map(r => `"${r}"`).join(" OR ")}) (Goa OR Panaji OR Panjim OR Margao OR Mapusa) after:${after}`,
  })));

  const results = await Promise.allSettled(jobs.map(async ({ source, query }) => {
    try {
      const jina = await jinaSearch(query, source.key);
      if (jina.length) return { source, results: jina };
      const direct = await directSearch(query, source);
      return { source, results: direct };
    } catch (error) {
      const direct = await directSearch(query, source).catch(() => [] as SearchResult[]);
      if (direct.length) return { source, results: direct };
      throw new Error(`${source.key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));

  for (const settled of results) {
    if (settled.status === "rejected") { failures.push(String(settled.reason?.message || settled.reason)); continue; }
    const { source, results: sourceResults } = settled.value;
    const seen = new Set<string>();
    for (const result of sourceResults) {
      if (seen.has(result.url)) continue;
      seen.add(result.url);
      const age = ageHours(result.context);
      if (age != null && age > 360) continue;
      if (!GOA.test(result.context) && !GOA.test(result.title)) continue;
      const postedAt = age == null ? new Date().toISOString() : new Date(Date.now() - age * 3600000).toISOString();
      discovered.push({
        title: result.title,
        company: companyFrom(result.title, result.context),
        location: "Goa",
        type: "Full-time",
        description: result.context.slice(0, 12000),
        apply_url: result.url,
        source: source.key,
        posted_at: postedAt,
      });
      sourceCounts[source.key]++;
    }
  }

  // Add a small unscoped Google pass to catch jobs where the board URL is nested
  // behind Google's redirect and therefore isn't returned by a site-restricted query.
  try {
    const broad = await jinaSearch(`Goa ("HR Coordinator" OR "HR Executive" OR "Human Resources" OR "Talent Acquisition" OR "HR Operations") after:${after}`, "linkedin");
    for (const result of broad) {
      const source = sourceFor(result.url);
      if (!source || source === "linkedin" && !/linkedin\.com\/jobs\//i.test(result.url)) continue;
      const age = ageHours(result.context);
      if (age != null && age > 360 || (!GOA.test(result.context) && !GOA.test(result.title))) continue;
      if (discovered.some(j => j.apply_url === result.url)) continue;
      discovered.push({ title: result.title, company: companyFrom(result.title, result.context), location: "Goa", type: "Full-time", description: result.context.slice(0, 12000), apply_url: result.url, source, posted_at: age == null ? new Date().toISOString() : new Date(Date.now() - age * 3600000).toISOString() });
      sourceCounts[source]++;
    }
  } catch (error) { failures.push(`google-broad: ${error instanceof Error ? error.message : String(error)}`); }

  const unique = new Map<string, Record<string, unknown>>();
  for (const job of discovered) {
    const key = `${String(job.title).toLowerCase()}|${String(job.company).toLowerCase()}|goa`;
    if (!unique.has(key)) unique.set(key, job);
  }
  const jobsToImport = [...unique.values()].slice(0, 100);
  const result = await importIndiaJobs({ jobs: jobsToImport, failures, source: "india-multi-source-vercel" });
  return { ok: failures.length === 0, windowDays: 15, roles: ROLES, discovered: jobsToImport.length, sourceCounts, failures, result };
}

export async function runGoaDiscovery() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server configuration is missing");
  const client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: state } = await client.from("job_discovery_state").select("last_started_at").eq("id", true).maybeSingle();
  const last = state?.last_started_at ? new Date(state.last_started_at).getTime() : 0;
  if (Date.now() - last < 6 * 60 * 60 * 1000) return { skipped: true, reason: "discovery ran within the last 6 hours" };
  await client.from("job_discovery_state").upsert({ id: true, last_started_at: new Date().toISOString() });
  try {
    const result = await discover();
    await client.from("job_discovery_state").update({ last_finished_at: new Date().toISOString(), last_result: result }).eq("id", true);
    return result;
  } catch (error) {
    await client.from("job_discovery_state").update({ last_finished_at: new Date().toISOString(), last_result: { error: String(error) } }).eq("id", true);
    throw error;
  }
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { return NextResponse.json(await runGoaDiscovery()); }
  catch (error) { console.error("Daily job collection failed", error); return NextResponse.json({ error: error instanceof Error ? error.message : "Discovery failed" }, { status: 500 }); }
}
