import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";

const ACTOR_ID = process.env.DECISION_MAKER_ACTOR_ID || "snipercoder~decision-maker-email-finder";
const HR_TITLE = /\b(hr|human resources|recruit|recruiter|recruiting|recruitment|talent acquisition|talent management|talent|people operations|people ops|people partner|staffing|resourcing)\b/i;
const PRIORITY_TITLE = /\b(head|director|manager|lead|partner|senior|hr business partner|talent acquisition)\b/i;
const ACTOR_CATEGORIES = ["director_head_president", "manager_entry_intern"] as const;

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

export function companyDomain(website?: string | null, _applyUrl?: string | null) {
  return normalizeDomain(text(website));
}

export async function resolveCompanyDomain(companyName: string, website?: string | null) {
  const direct = companyDomain(website);
  if (direct) return direct;
  const name = companyName.trim();
  if (!name) return "";
  try {
    const response = await fetch(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(name)}`, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) return "";
    const data = await response.json();
    if (!Array.isArray(data)) return "";
    const normalizedName = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const tokens = normalizedName.split(/\s+/).filter((token) => token.length > 2);
    const candidate = data.map((row) => ({ name: text(row?.name), domain: normalizeDomain(text(row?.domain)) })).filter((row) => row.domain).sort((a, b) => {
      const score = (candidateName: string) => { const n = candidateName.toLowerCase().replace(/[^a-z0-9]+/g, " "); return tokens.filter((token) => n.includes(token)).length; };
      return score(b.name) - score(a.name);
    })[0];
    return candidate?.domain || "";
  } catch (error) {
    console.warn(`Unable to resolve company domain for ${companyName}:`, error);
    return "";
  }
}

async function runActor(domain: string, category: typeof ACTOR_CATEGORIES[number]) {
  const token = required("APIFY_API_TOKEN");
  const endpoint = `https://api.apify.com/v2/actors/${encodeURIComponent(ACTOR_ID)}/run-sync-get-dataset-items?maxItems=10&maxTotalChargeUsd=0.05`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ domain, decision_maker_category: category, max_leads_to_find: 10 }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Decision-maker Actor failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  const data = await response.json();
  return Array.isArray(data) ? data as Record<string, unknown>[] : [];
}

function normalizeLead(row: Record<string, unknown>) {
  const name = text(row.name, row.full_name, row.fullName, row.contact_name, row.contactName, [text(row.first_name, row.firstName), text(row.last_name, row.lastName)].filter(Boolean).join(" "));
  const title = text(row.title, row.job_title, row.jobTitle, row.headline, row.position, row.position_title, row.positionTitle, row.role);
  const email = text(row.email, row.work_email, row.workEmail, row.business_email, row.businessEmail, row.contact_email, row.email_address).toLowerCase();
  const linkedin = text(row.linkedin, row.linkedin_url, row.linkedinUrl, row.profileUrl, row.profile_url, row.linkedin_profile);
  const company = text(row.company, row.company_name, row.companyName, row.organization, row.organization_name);
  if (!name || !email || !HR_TITLE.test(title)) return null;
  return { name, title, email, linkedin_url: linkedin || null, raw: { ...row, normalized_company: company || null } };
}

export async function enrichCompany(companyId: string, domain: string, companyName?: string, website?: string | null) {
  const normalizedDomain = (await resolveCompanyDomain(companyName || "", domain || website || null)) || normalizeDomain(domain);
  if (!normalizedDomain) return { count: 0, skipped: true };
  const client = db();
  const allItems: Record<string, unknown>[] = [];
  for (const category of ACTOR_CATEGORIES) {
    try {
      allItems.push(...await runActor(normalizedDomain, category));
    } catch (error) {
      console.warn(`Decision-maker enrichment category ${category} failed for ${normalizedDomain}:`, error);
    }
  }
  const leads = allItems.map(normalizeLead).filter((x): x is NonNullable<ReturnType<typeof normalizeLead>> => Boolean(x));
  const unique = Array.from(new Map(leads.map((lead) => [`${lead.email}|${lead.name}`.toLowerCase(), lead])).values());
  const ranked = unique.sort((a, b) => Number(PRIORITY_TITLE.test(b.title)) - Number(PRIORITY_TITLE.test(a.title))).slice(0, 5);
  if (ranked.length) {
    await client.from("decision_makers").delete().eq("company_id", companyId);
    const { error } = await client.from("decision_makers").insert(ranked.map((lead) => ({ ...lead, company_id: companyId, source: ACTOR_ID, last_enriched_at: new Date().toISOString() })));
    if (error) throw new Error(`Unable to store decision makers: ${error.message}`);
  }
  await client.from("companies").update({ domain: normalizedDomain, website: website || `https://${normalizedDomain}`, updated_at: new Date().toISOString() }).eq("id", companyId);
  return { count: ranked.length, skipped: false, domain: normalizedDomain };
}

export function companyKey(name: string, domain: string) {
  return domain || createHash("sha256").update(name.toLowerCase().trim()).digest("hex").slice(0, 24);
}
