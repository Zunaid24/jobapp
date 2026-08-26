import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";

const ACTOR_ID = process.env.CONTACT_ENRICHMENT_ACTOR_ID || "harvestapi~linkedin-company-employees";
const HR_TITLE = /\b(hr|human resources|recruiter|recruiting|recruitment|talent acquisition|talent management|talent partner|people operations|people ops|people partner|hr business partner|staffing|resourcing|hiring manager)\b/i;
const PRIORITY_TITLE = /\b(recruiter|talent acquisition|talent partner|recruitment|recruiting|hr manager|human resources manager|hr business partner|people partner|people operations|head of hr|head of human resources|head of talent)\b/i;

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function text(...values: unknown[]) {
  return values.find((v) => typeof v === "string" && v.trim())?.toString().trim() || "";
}

function db() {
  return createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function normalizeDomain(value: string) {
  try {
    const url = value.includes("://") ? new URL(value) : new URL(`https://${value}`);
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (!host || /(?:linkedin|indeed|simplyhired|glassdoor|naukri|foundit|monster|ziprecruiter|apify)\./i.test(host)) return "";
    return host;
  } catch {
    return "";
  }
}

function normalizeLinkedInCompanyUrl(value: string) {
  const raw = text(value);
  if (!raw) return "";
  try {
    const url = raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`);
    if (!/linkedin\.com$/i.test(url.hostname.replace(/^www\./i, ""))) return "";
    const match = url.pathname.match(/^\/company\/([^/?#]+)/i);
    return match ? `https://www.linkedin.com/company/${match[1]}` : "";
  } catch {
    return "";
  }
}

async function resolveCompanyIdentity(companyName: string, website?: string | null, linkedinUrl?: string | null) {
  const directLinkedIn = normalizeLinkedInCompanyUrl(text(linkedinUrl));
  const directDomain = normalizeDomain(text(website));
  if (directLinkedIn || directDomain) return { linkedinUrl: directLinkedIn, domain: directDomain };

  const name = companyName.trim();
  if (!name) return { linkedinUrl: "", domain: "" };

  try {
    const response = await fetch(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(name)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return { linkedinUrl: "", domain: "" };
    const data = await response.json();
    if (!Array.isArray(data)) return { linkedinUrl: "", domain: "" };

    const normalizedName = name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const tokens = normalizedName.split(/\s+/).filter((token) => token.length > 2);
    const candidates = data
      .map((row) => ({
        name: text(row?.name),
        domain: normalizeDomain(text(row?.domain)),
        linkedin: normalizeLinkedInCompanyUrl(text(row?.linkedin?.url, row?.linkedin, row?.linkedin_url)),
      }))
      .filter((row) => row.domain || row.linkedin);

    candidates.sort((a, b) => {
      const score = (candidateName: string) => {
        const normalized = candidateName.toLowerCase().replace(/[^a-z0-9]+/g, " ");
        return tokens.filter((token) => normalized.includes(token)).length;
      };
      return score(b.name) - score(a.name);
    });

    return { linkedinUrl: candidates[0]?.linkedin || "", domain: candidates[0]?.domain || "" };
  } catch (error) {
    console.warn(`Unable to resolve company identity for ${companyName}:`, error);
    return { linkedinUrl: "", domain: "" };
  }
}

function extractNestedEmail(value: unknown) {
  if (typeof value === "string") return value.trim().toLowerCase();
  if (!value || typeof value !== "object") return "";
  const row = value as Record<string, unknown>;
  return text(row.email, row.work_email, row.workEmail, row.business_email, row.businessEmail, row.address).toLowerCase();
}

function normalizeLead(row: Record<string, unknown>) {
  const firstName = text(row.firstName, row.first_name);
  const lastName = text(row.lastName, row.last_name);
  const name = text(row.name, row.full_name, row.fullName, firstName && lastName ? `${firstName} ${lastName}` : "");
  const title = text(row.jobTitle, row.job_title, row.title, row.headline, row.position, row.role);
  const linkedin = text(row.profileUrl, row.profile_url, row.linkedinUrl, row.linkedin_url, row.linkedin);
  const directEmail = text(row.email, row.work_email, row.workEmail, row.business_email, row.businessEmail).toLowerCase();
  const contactInfo = row.contact_info && typeof row.contact_info === "object" ? row.contact_info as Record<string, unknown> : null;
  const emails = Array.isArray(row.emails) ? row.emails.map(extractNestedEmail).filter(Boolean) : [];
  const email = directEmail || text(contactInfo?.email).toLowerCase() || emails[0] || "";
  const company = text(row.companyName, row.company_name, row.company, row.current_company);

  if (!name || !title || !HR_TITLE.test(title) || !email) return null;
  return {
    name,
    title,
    email,
    linkedin_url: linkedin || null,
    raw: { ...row, normalized_company: company || null },
  };
}

async function runActor(companyLinkedInUrl: string, companyWebsite?: string | null) {
  const token = required("APIFY_API_TOKEN");
  const endpoint = `https://api.apify.com/v2/actors/${encodeURIComponent(ACTOR_ID)}/run-sync-get-dataset-items?maxItems=20&maxTotalChargeUsd=0.30`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      profileScraperMode: "Full + email search ($12 per 1k)",
      maxItems: 20,
      companies: [companyLinkedInUrl],
      searchQuery: "HR recruiter talent acquisition human resources recruitment people operations",
      functionIds: ["12"],
      companyBatchMode: "one_by_one",
      ...(companyWebsite ? { website: companyWebsite } : {}),
    }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`HR contact Actor failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  const data = await response.json();
  return Array.isArray(data) ? data as Record<string, unknown>[] : [];
}

export async function enrichCompany(companyId: string, domain: string, companyName?: string, website?: string | null) {
  const client = db();
  const { data: companyRow } = await client.from("companies").select("name,domain,website,linkedin_url").eq("id", companyId).maybeSingle();
  const resolved = await resolveCompanyIdentity(
    companyName || text(companyRow?.name),
    website || companyRow?.website || resolvedDomainUrl(domain),
    companyRow?.linkedin_url,
  );

  const normalizedDomain = resolved.domain || normalizeDomain(domain);
  const companyLinkedInUrl = resolved.linkedinUrl;
  if (!companyLinkedInUrl) {
    console.warn(`Skipping HR contact enrichment for ${companyName || companyRow?.name || companyId}: no LinkedIn company URL`);
    return { count: 0, skipped: true, reason: "missing_company_linkedin_url" };
  }

  const items = await runActor(companyLinkedInUrl, normalizedDomain ? `https://${normalizedDomain}` : null);
  const leads = items.map(normalizeLead).filter((x): x is NonNullable<ReturnType<typeof normalizeLead>> => Boolean(x));
  const unique = Array.from(new Map(leads.map((lead) => [`${lead.email}|${lead.name}`.toLowerCase(), lead])).values());
  const ranked = unique.sort((a, b) => Number(PRIORITY_TITLE.test(b.title)) - Number(PRIORITY_TITLE.test(a.title))).slice(0, 5);

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

  await client.from("companies").update({
    domain: normalizedDomain || null,
    website: website || companyRow?.website || (normalizedDomain ? `https://${normalizedDomain}` : null),
    linkedin_url: companyLinkedInUrl,
    updated_at: new Date().toISOString(),
  }).eq("id", companyId);

  return { count: ranked.length, skipped: false, domain: normalizedDomain, companyLinkedInUrl };
}

function resolvedDomainUrl(domain: string) {
  const normalized = normalizeDomain(domain);
  return normalized ? `https://${normalized}` : null;
}

export function companyDomain(website?: string | null, _applyUrl?: string | null) {
  return normalizeDomain(text(website));
}

export function companyKey(name: string, domain: string) {
  return domain || createHash("sha256").update(name.toLowerCase().trim()).digest("hex").slice(0, 24);
}
