import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const SELECT = "id,title,company,location,type,match_score,description,apply_url,contact_email,decision_maker_name,decision_maker_title,posted_at,source,company_id";
const WINDOW_DAYS = 15;
function db() { const url = process.env.NEXT_PUBLIC_SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY; if (!url || !key) throw new Error("Supabase server configuration is missing"); return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }); }

export async function GET(request: Request) {
  try {
    const location = new URL(request.url).searchParams.get("location") === "Remote" ? "Remote" : "Goa";
    const client = db();
    const cutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    let query = client.from("jobs").select(SELECT).eq("location", location).gte("posted_at", cutoff).lte("posted_at", new Date(Date.now() + 60 * 60 * 1000).toISOString()).order("posted_at", { ascending: false, nullsFirst: false }).limit(location === "Remote" ? 20 : 100);
    const { data: jobs, error } = await query;
    if (error) throw error;
    return NextResponse.json({ jobs: (jobs ?? []).map(job => ({ ...job, match: job.match_score ?? 0, company_details: null, decision_makers: [] })), remoteDailyLimit: 20, freshnessDays: WINDOW_DAYS, source: "india-multi-source" });
  } catch (error) {
    console.error("Jobs endpoint failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load jobs" }, { status: 500 });
  }
}
