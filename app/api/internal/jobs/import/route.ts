import { NextResponse } from "next/server";
import { importIndiaJobs } from "@/lib/imported-jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization");
  if (!secret || authorization !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    if (!Array.isArray(body.jobs)) {
      return NextResponse.json({ error: "jobs must be an array" }, { status: 400 });
    }
    const result = await importIndiaJobs({ jobs: body.jobs, failures: Array.isArray(body.failures) ? body.failures : [], source: body.source });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("India job import failed", error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Job import failed" }, { status: 500 });
  }
}
