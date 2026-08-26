import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { refreshDailyJobs } from "@/lib/apify";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server configuration is missing");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export async function GET(request: Request) {
  try {
    const location = new URL(request.url).searchParams.get("location") === "Remote" ? "Remote" : "Goa";
    const today = new Date().toISOString().slice(0, 10);
    const client = db();

    let { data: jobs, error } = await client
      .from("jobs")
      .select("id,title,company,location,type,match_score,description,apply_url,contact_email,posted_at,source")
      .eq("location", location)
      .eq("collected_on", today)
      .order("match_score", { ascending: false })
      .limit(location === "Remote" ? 20 : 50);

    if (error) throw error;

    if (!jobs?.length) {
      const { data: run } = await client.from("job_collection_runs").select("status").eq("collection_date", today).maybeSingle();
      if (!run) {
        await refreshDailyJobs();
        const refreshed = await client
          .from("jobs")
          .select("id,title,company,location,type,match_score,description,apply_url,contact_email,posted_at,source")
          .eq("location", location)
          .eq("collected_on", today)
          .order("match_score", { ascending: false })
          .limit(location === "Remote" ? 20 : 50);
        jobs = refreshed.data ?? [];
        error = refreshed.error;
      }
    }

    if (error) throw error;
    return NextResponse.json({
      jobs: (jobs ?? []).map((job) => ({ ...job, match: job.match_score ?? 0 })),
      remoteDailyLimit: 20,
      collectedOn: today,
    });
  } catch (error) {
    console.error("Jobs endpoint failed", error);
    return NextResponse.json({ error: "Unable to load jobs" }, { status: 500 });
  }
}
