import { createClient } from "@supabase/supabase-js";

type Job = { id: string; title: string; company: string; location: string; type: string; description?: string | null; apply_url?: string | null; posted_at?: string | null; source?: string | null };
type Ranked = { id: string; score: number; decision: "KEEP" | "REJECT"; reasons: string[] };

// Gemini 2.5 Flash-Lite was retired for new users. Keep the model configurable,
// but use the current stable low-cost production model by default.
const MODEL = process.env.GEMINI_JOB_MODEL || "gemini-3.5-flash-lite";
function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`Missing environment variable: ${name}`); return value; }
function db() { return createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } }); }

async function gemini(prompt: string, schema: Record<string, unknown>) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(required("GEMINI_API_KEY"))}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, responseMimeType: "application/json", responseSchema: schema } }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Gemini job controller failed (${response.status}): ${detail.slice(0, 1000)}`);
  }
  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini job controller returned no content");
  return JSON.parse(text) as Record<string, unknown>;
}

export async function planDailyJobSearch() {
  const { data: profile } = await db().from("candidate_profiles").select("name,experience,skills").order("updated_at", { ascending: false }).limit(1).maybeSingle();
  const prompt = `You are the cost controller for a job-search app. The candidate is seeking NEW jobs in Goa only. Target roles are HR Executive, HR Coordinator, HR Recruiter, Talent Acquisition, Talent Acquisition Specialist and closely equivalent HR recruiting roles. Use the candidate profile to choose the smallest useful search configuration. Never broaden to unrelated HR management roles unless clearly compatible with the experience. The absolute job ceiling is 50, but the normal target is 10 high-quality jobs. Keep the Actor request small: prefer 10-15 results, never above 20. Candidate: ${JSON.stringify(profile || {})}`;
  const result = await gemini(prompt, { type: "object", properties: { keyword: { type: "string" }, location: { type: "string" }, maxResults: { type: "integer" }, postedMaxDays: { type: "integer" }, roleQueries: { type: "array", items: { type: "string" } } }, required: ["keyword", "location", "maxResults", "postedMaxDays", "roleQueries"] });
  return { keyword: "HR", location: "Goa", maxResults: Math.min(20, Math.max(10, Number(result.maxResults) || 12)), postedMaxDays: Math.min(15, Math.max(1, Number(result.postedMaxDays) || 7)), roleQueries: Array.isArray(result.roleQueries) ? result.roleQueries.slice(0, 6).map(String) : [] };
}

export async function rankNewJobs(jobs: Job[]) {
  if (!jobs.length) return [] as Ranked[];
  const { data: profile } = await db().from("candidate_profiles").select("name,experience,skills").order("updated_at", { ascending: false }).limit(1).maybeSingle();
  const compact = jobs.map(j => ({ id: j.id, title: j.title, company: j.company, location: j.location, type: j.type, posted_at: j.posted_at, description: (j.description || "").slice(0, 6000) }));
  const prompt = `You are the final relevance and quality gate for a Goa-only HR job search. Candidate profile: ${JSON.stringify(profile || {})}. Keep ONLY genuinely suitable NEW jobs for this candidate. Hard requirements: Goa location; HR Executive, HR Coordinator, HR Recruiter, Talent Acquisition or closely equivalent recruiting/HR coordination roles; reject unrelated HR roles, wrong locations, obvious duplicates, and jobs whose stated experience is clearly incompatible. Prefer jobs that match the candidate's experience and skills. Score 0-100. Return one decision per supplied job ID. Jobs: ${JSON.stringify(compact)}`;
  const result = await gemini(prompt, { type: "object", properties: { results: { type: "array", items: { type: "object", properties: { id: { type: "string" }, score: { type: "integer" }, decision: { type: "string", enum: ["KEEP", "REJECT"] }, reasons: { type: "array", items: { type: "string" } } }, required: ["id", "score", "decision", "reasons"] } } }, required: ["results"] });
  return Array.isArray(result.results) ? result.results.map((x: any) => ({ id: String(x.id), score: Math.max(0, Math.min(100, Number(x.score) || 0)), decision: x.decision === "KEEP" ? "KEEP" : "REJECT", reasons: Array.isArray(x.reasons) ? x.reasons.slice(0, 3).map(String) : [] })).filter(x => jobs.some(j => j.id === x.id)) : [];
}
