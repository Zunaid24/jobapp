import { NextResponse } from "next/server";
import { refreshDailyJobs } from "@/lib/apify";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization");
  if (!secret || authorization !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(request.url);
    const force = url.searchParams.get("force") === "1";
    const result = await refreshDailyJobs({ force });
    return NextResponse.json({ ok: true, force, ...result });
  } catch (error) {
    console.error("Daily job collection failed", error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Job collection failed" }, { status: 500 });
  }
}
