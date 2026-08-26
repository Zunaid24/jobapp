import { createClient } from "@supabase/supabase-js";

const EMPLOYEE_ACTOR = "u1EmtfXEWdmHmn4yW";
const EMAIL_ACTOR = "bfH8Ermocz8oYKQVO";
const HR_TITLES = [
  "Recruiter", "Talent Acquisition", "Talent Acquisition Specialist", "Talent Acquisition Partner",
  "Talent Acquisition Manager", "Recruitment Manager", "HR Manager", "Human Resources Manager",
  "HR Business Partner", "People Partner", "People Operations", "Head of HR", "Head of Talent",
  "Talent Partner", "Hiring Manager", "Staffing", "Resourcing"
];
const HR_RE = /\b(hr|human resources|recruiter|recruiting|recruitment|talent acquisition|talent management|talent partner|people operations|people ops|people partner|hr business partner|staffing|resourcing|hiring manager|people & culture|people and culture)\b/i;
const PRIORITY_RE = /\b(recruiter|talent acquisition|recruitment|hr manager|human resources manager|hr business partner|people partner|people operations|head of hr|head of talent|talent partner|hiring manager)\b/i;

function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`Missing environment variable: ${name}`); return value; }
function text(...values: unknown[]) { return values.find(v => typeof v === "string" && v.trim())?.toString().trim() || ""; }
function db() { return createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } }); }

function normalizeLinkedIn(value: unknown) {
  const raw = text(value); if (!raw) return "";
  try { const u = new URL(raw.includes("://") ? raw : `https://${raw}`); if (!/linkedin\.com$/i.test(u.hostname.replace(/^www\./, ""))) return ""; return `https://www.linkedin.com${u.pathname.replace(/\/$/, "")}`; } catch { return ""; }
}

function firstPositionTitle(row: Record<string, unknown>) {
  const positions = row.currentPosition ?? row.currentPositions ?? row.current_position ?? row.current_positions;
  if (Array.isArray(positions)) {
    for (const position of positions) {
      if (position && typeof position === "object") {
        const p = position as Record<string, unknown>;
        const title = text(p.position, p.jobTitle, p.job_title, p.title, p.role, p.headline);
        if (title) return title;
      }
    }
  }
  return "";
}

function normalizePerson(row: Record<string, unknown>, companyName: string) {
  const first = text(row.firstName, row.first_name);
  const last = text(row.lastName, row.last_name);
  const name = text(row.name, row.fullName, row.full_name, first && last ? `${first} ${last}` : "");
  const title = text(
    row.jobTitle, row.job_title, row.title, row.headline, row.position, row.role,
    row.currentJobTitle, row.current_job_title, firstPositionTitle(row)
  );
  const linkedin = normalizeLinkedIn(row.profileUrl ?? row.profile_url ?? row.linkedinUrl ?? row.linkedin_url ?? row.linkedin ?? row.url);
  const company = text(row.companyName, row.company_name, row.company, row.current_company, row.currentCompany);
  if (!name || !title || !linkedin || !HR_RE.test(title)) return null;
  return { name, title, linkedin_url: linkedin, company: company || companyName, email: null as string | null, raw: row };
}

async function callActor(actorId: string, input: Record<string, unknown>, maxCharge = "0.10", timeoutSeconds = 90) {
  const token = required("APIFY_API_TOKEN");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (timeoutSeconds + 10) * 1000);
  const endpoint = `https://api.apify.com/v2/actors/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?timeout=${timeoutSeconds}&maxTotalChargeUsd=${maxCharge}`;
  try {
    const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(input), cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`Apify actor ${actorId} failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    const data = await response.json(); return Array.isArray(data) ? data as Record<string, unknown>[] : [];
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error(`HR contact lookup timed out after ${timeoutSeconds} seconds. Please try again.`);
    throw error;
  } finally { clearTimeout(timer); }
}

export async function findHrContacts(companyName: string, companyLinkedInUrl?: string | null) {
  const identity = normalizeLinkedIn(companyLinkedInUrl) || companyName.trim();
  if (!identity) throw new Error("Company name is required for HR contact lookup.");

  const items = await callActor(EMPLOYEE_ACTOR, {
    companies: [identity],
    jobTitles: HR_TITLES,
    maxItems: 10,
    maxItemsPerCompany: 10,
    companyBatchMode: "one_by_one",
    profileScraperMode: "Short ($4 per 1k)",
    takePages: 1,
    startPage: 1,
  }, "0.10", 90);

  const people = items.map(x => normalizePerson(x, companyName)).filter((x): x is NonNullable<ReturnType<typeof normalizePerson>> => Boolean(x));
  const unique = Array.from(new Map(people.map(p => [p.linkedin_url.toLowerCase(), p])).values());
  unique.sort((a, b) => Number(PRIORITY_RE.test(b.title)) - Number(PRIORITY_RE.test(a.title)) || a.name.localeCompare(b.name));
  return unique.slice(0, 10);
}

function extractEmail(row: Record<string, unknown>) {
  const direct = text(row.email, row.workEmail, row.work_email, row.businessEmail, row.business_email, row.emailAddress).toLowerCase();
  if (direct) return direct;
  const contact = row.contact_info && typeof row.contact_info === "object" ? row.contact_info as Record<string, unknown> : null;
  return text(contact?.email, contact?.work_email, contact?.workEmail).toLowerCase();
}

export async function findEmails(linkedinUrls: string[]) {
  const urls = Array.from(new Set(linkedinUrls.map(normalizeLinkedIn).filter(Boolean))).slice(0, 5);
  if (!urls.length) return [];
  const items = await callActor(EMAIL_ACTOR, { urls }, "0.10", 90);
  return items.map(row => ({
    linkedin_url: normalizeLinkedIn(row.profileUrl ?? row.profile_url ?? row.linkedinUrl ?? row.linkedin_url ?? row.linkedin ?? row.url),
    email: extractEmail(row),
    raw: row,
  })).filter(x => x.linkedin_url && x.email);
}

export async function resolveCompanyLinkedIn(companyId: string) {
  const client = db();
  const { data: company } = await client.from("companies").select("id,name,linkedin_url,website,domain").eq("id", companyId).maybeSingle();
  if (!company) throw new Error("Company not found");
  const existing = normalizeLinkedIn(company.linkedin_url);
  if (existing) return existing;
  const query = encodeURIComponent(company.name);
  try {
    const response = await fetch(`https://www.google.com/search?q=${query}+site%3Alinkedin.com%2Fcompany`, { headers: { "User-Agent": "Mozilla/5.0" }, cache: "no-store" });
    const html = await response.text();
    const match = html.match(/https?:\/\/(?:www\.)?linkedin\.com\/company\/[A-Za-z0-9._-]+/i);
    const linkedin = normalizeLinkedIn(match?.[0]);
    if (linkedin) { await client.from("companies").update({ linkedin_url: linkedin, updated_at: new Date().toISOString() }).eq("id", companyId); return linkedin; }
  } catch { /* fallback below */ }
  return "";
}
