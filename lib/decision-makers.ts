import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";

const ACTOR_ID = process.env.DECISION_MAKER_ACTOR_ID || "snipercoder~decision-maker-email-finder";
const HR_TITLE = /\b(hr|human resources|recruit|recruiter|recruiting|talent acquisition|talent|people operations|people ops|people partner|staffing|resourcing)\b/i;
const PRIORITY_TITLE = /\b(lead|head|manager|director|senior|partner)\b/i;

function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`Missing environment variable: ${name}`); return value; }
function text(...values: unknown[]) { return values.find((v) => typeof v === "string" && v.trim())?.toString().trim() || ""; }
function db() { return createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } }); }

function normalizeDomain(value: string) {
  try {
    const url = value.includes("://") ? new URL(value) : new URL(`https://${value}`);
    return url.hostname.replace(/^www\./i, "").toLowerCase();
  } catch { return ""; }
}

export function companyDomain(website?: string | null, applyUrl?: string | null) {
  return normalizeDomain(text(website, applyUrl));
}

async function runActor(domain: string) {
  const token = required("APIFY_API_TOKEN");
  const endpoint = `https://api.apify.com/v2/actors/${encodeURIComponent(ACTOR_ID)}/run-sync-get-dataset-items?maxItems=10&maxTotalChargeUsd=0.05`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ domain, max_leads_to_find: 10 }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Decision-maker Actor failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  const data = await response.json();
  return Array.isArray(data) ? data as Record<string, unknown>[] : [];
}

function normalizeLead(row: Record<string, unknown>) {
  const name = text(row.name, row.full_name, row.fullName, row.contact_name);
  const title = text(row.title, row.job_title, row.jobTitle, row.headline, row.position);
  const email = text(row.email, row.work_email, row.business_email, row.contact_email).toLowerCase();
  const linkedin = text(row.linkedin, row.linkedin_url, row.linkedinUrl, row.profileUrl);
  if (!name || !email || !HR_TITLE.test(title)) return null;
  return { name, title, email, linkedin_url: linkedin || null, raw: row };
}

export async function enrichCompany(companyId: string, domain: string) {
  if (!domain) return { count: 0, skipped: true };
  const client = db();
  const items = await runActor(domain);
  const leads = items.map(normalizeLead).filter((x): x is NonNullable<ReturnType<typeof normalizeLead>> => Boolean(x));
  const ranked = leads.sort((a, b) => Number(PRIORITY_TITLE.test(b.title)) - Number(PRIORITY_TITLE.test(a.title))).slice(0, 5);
  if (ranked.length) {
    await client.from("decision_makers").delete().eq("company_id", companyId);
    const { error } = await client.from("decision_makers").insert(ranked.map((lead) => ({ ...lead, company_id: companyId, source: ACTOR_ID, last_enriched_at: new Date().toISOString() })));
    if (error) throw new Error(`Unable to store decision makers: ${error.message}`);
  }
  await client.from("companies").update({ updated_at: new Date().toISOString() }).eq("id", companyId);
  return { count: ranked.length, skipped: false };
}

export function companyKey(name: string, domain: string) {
  return domain || createHash("sha256").update(name.toLowerCase().trim()).digest("hex").slice(0, 24);
}
