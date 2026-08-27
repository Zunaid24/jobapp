import { NextResponse } from "next/server";
import { importIndiaJobs } from "@/lib/imported-jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ROLES = [
  "HR Coordinator", "HR Executive", "HR Operations", "HR Operations Specialist",
  "HR Onboarding", "Onboarding Specialist", "Recruitment Coordinator",
  "Talent Acquisition Specialist", "Recruitment Operations", "HRIS Analyst",
  "Employee Lifecycle", "HR Administrator", "HR Assistant", "People Operations Coordinator",
  "HR Compliance", "HR Recruiter", "Human Resources Officer", "People & Culture Executive",
];
const SOURCES = [
  { key: "linkedin", site: "linkedin.com/jobs/view" },
  { key: "indeed", site: "in.indeed.com/viewjob" },
  { key: "foundit", site: "foundit.in/job" },
  { key: "naukri", site: "naukri.com/job-listings" },
];
const GOA = /\b(goa|panaji|panjim|margao|mapusa|vasco(?: da gama)?|calangute|porvorim|verna|bardez|anjuna|candolim|betalbatim|mobor)\b/i;

function decode(value: string) { return value.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " "); }
function strip(value: string) { return decode(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()); }
function absoluteUrl(href: string) {
  if (href.startsWith("/url?q=")) return decode(href.slice(7).split("&")[0]);
  if (href.startsWith("http")) return href;
  return null;
}
function ageHours(text: string) {
  const t = text.toLowerCase();
  if (/\bjust now\b|\btoday\b|\bhours? ago\b/.test(t)) return 1;
  const m = t.match(/(\d+)\s*(day|week|month)s?\s*ago/);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2].startsWith("week") ? n * 168 : m[2].startsWith("month") ? n * 720 : n * 24;
}
function companyFrom(title: string, text: string, source: string) {
  const cleanTitle = strip(title).replace(/\s*[|·-]\s*(LinkedIn|Indeed|Foundit|Naukri).*$/i, "");
  if (source === "linkedin") {
    const parts = cleanTitle.split(/\s+[-–—]\s+/).map(s => s.trim()).filter(Boolean);
    if (parts.length > 1) return parts[parts.length - 1];
  }
  const location = text.match(/([A-Z][A-Za-z0-9&.,'()\- ]{2,70})\s+(?:Goa|Panaji|Panjim|Margao|Mapusa|Vasco|Calangute|Verna|Bardez)\b/i);
  if (location?.[1]) return location[1].trim();
  const titleParts = cleanTitle.split(/\s+[-–—]\s+/).map(s => s.trim()).filter(Boolean);
  if (titleParts.length > 1 && !/job post|salary|jobs?$/i.test(titleParts[1])) return titleParts[1];
  return "Unknown company";
}
function extractResults(html: string, source: string) {
  const out: Array<{title:string,url:string,context:string}> = [];
  const re = /<a[^>]+href="([^"]+)"[^>]*>[\s\S]{0,5000}?<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const url = absoluteUrl(match[1]); if (!url || !url.startsWith("http")) continue;
    if (!url.includes(source === "linkedin" ? "linkedin.com/jobs/" : source === "indeed" ? "indeed.com/" : source === "foundit" ? "foundit.in/" : "naukri.com/")) continue;
    const title = strip(match[2]);
    const context = strip(html.slice(match.index, match.index + 5000));
    if (title && !out.some(x => x.url === url)) out.push({ title, url, context });
  }
  return out.slice(0, 10);
}
async function google(query: string) {
  const url = `https://www.google.com/search?hl=en&num=10&q=${encodeURIComponent(query)}`;
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; JobApp/1.0)" }, cache: "no-store" });
  if (!response.ok) throw new Error(`Google ${response.status}`);
  return response.text();
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const failures: string[] = [];
  const discovered: Array<Record<string, unknown>> = [];
  const sourceCounts: Record<string, number> = Object.fromEntries(SOURCES.map(s => [s.key, 0]));
  const roleQuery = ROLES.map(r => `"${r}"`).join(" OR ");

  // One Google request per board keeps the cron cheap while still discovering
  // board-indexed jobs without relying on the Copilot/GitHub workflow.
  for (const source of SOURCES) {
    try {
      const html = await google(`site:${source.site} (${roleQuery}) Goa`);
      for (const result of extractResults(html, source.key)) {
        const age = ageHours(result.context);
        if (age == null || age > 360) continue;
        const company = companyFrom(result.title, result.context, source.key);
        if (!GOA.test(result.context) && !GOA.test(result.title)) continue;
        discovered.push({ title: result.title, company, location: "Goa", type: "Full-time", description: result.context.slice(0, 12000), apply_url: result.url, source: source.key, posted_at: new Date(Date.now() - age * 3600000).toISOString() });
        sourceCounts[source.key]++;
      }
    } catch (error) { failures.push(`${source.key}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  const result = await importIndiaJobs({ jobs: discovered, failures, source: "india-multi-source-vercel" });
  return NextResponse.json({ ok: failures.length === 0, windowDays: 15, roles: ROLES, discovered: discovered.length, sourceCounts, failures, result });
}
