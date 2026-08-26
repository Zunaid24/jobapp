import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";

const ACTOR_ID = process.env.DECISION_MAKER_ACTOR_ID || "snipercoder~decision-maker-email-finder";
const HR_TITLE = /\b(hr|human resources|recruit|recruiter|recruiting|recruitment|talent acquisition|talent management|talent|people operations|people ops|people partner|staffing|resourcing)\b/i;
const PRIORITY_TITLE = /\b(head|director|manager|lead|partner|senior|hr business partner|talent acquisition)\b/i;

function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`Missing environment variable: ${name}`); return value; }
function text(...values: unknown[]) { return values.find((v) => typeof v === "string" && v.trim())?.toString().trim() || ""; }
function db() { return createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } }); }

function normalizeDomain(value: string) {
  try {
    const url = value.includes("://") ? new URL(value) : new URL(`https://${value}`);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (!host || /(?:linkedin|indeed|simplyhired|glassdoor|naukri|foundit|monster|ziprecruiter|apify)\./i.test(host)) return "";
    return host;
  } catch { return ""; }
}

export function companyDomain(website?: string | null, applyUrl?: string | null) {
  // Deliberately ignore applyUrl. Most job URLs are LinkedIn/Indeed URLs and
  // using those as the company domain makes the second Actor search the job
  // board instead of the employer.
  return normalizeDomain(text(website));
}

async function runActor(domain: string) {
  const token = required("APIFY_API_TOKEN");
  const endpoint = `https://api.apify.com/v2/actors/${encodeURIComponent(ACTOR_ID)}/run-sync-get-dataset-items?maxItems=10&maxTotalChargeUsd=0.05`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      domain,
      decision_maker_category: "hr",
      max_leads_to_find: 10,
    }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Decision-maker Actor failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  const data = await response.json();
  return Array.isArray(data) ? data as Record<string, unknown>[] : [];
}

function normalizeLead(row: Record<string, unknown>) {
  const name = text(
    row.name,
    row.full_name,
    row.fullName,
    row.contact_name,
    row.contactName,
    [text(row.first_name, row.firstName), text(row.last_name, row.lastName)].filter(Boolean).join(" "),
  );
  const title = text(row.title, row.job_title, row.jobTitle, row.headline, row.position, row.position_title, row.positionTitle, row.role);
  const email = text(row.email, row.work_email, row.workEmail, row.business_email, row.businessEmail, row.contact_email, row.email_address).toLowerCase();
  const linkedin = text(row.linkedin, row.linkedin_url, row.linkedinUrl, row.profileUrl, row.profile_url, row.linkedin_profile);
  const company = text(row.company, row.company_name, row.companyName, row.organization, row.organization_name);

  // The actor is asked for HR decision makers, but keep this defensive check
  // so a future actor build cannot store unrelated sales/marketing contacts.
  if (!name || !email || !HR_TITLE.test(title)) return null;
  return { name, title, email, linkedin_url: linkedin || null, raw: { ...row, normalized_company: company || null } };
}

export async function enrichCompany(companyId: string, domain: string) {
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedDomain) return { count: 0, skipped: true };

  const client = db();
  const items = await runActor(normalizedDomain);
  const leads = items.map(normalizeLead).filter((x): x is NonNullable<ReturnType<typeof normalizeLead>> => Boolean(x));
  const ranked = leads
    .sort((a, b) => Number(PRIORITY_TITLE.test(b.title)) - Number(PRIORITY_TITLE.test(a.title)))
    .slice(0, 5);

  if (ranked.length) {
    await client.from("decision_makers").delete().eq("company_id", companyId);
    const { error } = await client.from("decision_makers").insert(ranked.map((lead) => ({
      ...lead,
      company_id: companyId,
      source: ACTOR_ID,
      last_enriched_at: new Date().toISOString(),
    })));
    if (error) throw new Error(`Unable to store decision makers: ${error.message}`);
  }

  await client.from("companies").update({ updated_at: new Date().toISOString() }).eq("id", companyId);
  return { count: ranked.length, skipped: false };
}

export function companyKey(name: string, domain: string) {
  return domain || createHash("sha256").update(name.toLowerCase().trim()).digest("hex").slice(0, 24);
}
