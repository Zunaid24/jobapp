import { NextResponse } from "next/server";
import { refreshDailyJobs } from "@/lib/apify";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await refreshDailyJobs();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("Daily job collection failed", error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Job collection failed" }, { status: 500 });
  }
}
