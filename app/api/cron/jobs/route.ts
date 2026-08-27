import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization");
  if (!secret || authorization !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Job discovery now runs on the free India JobSpy GitHub Action. Keeping this
  // endpoint as a health/status route prevents an old Vercel cron from invoking
  // the removed Jobvetta dependency.
  return NextResponse.json({
    ok: true,
    source: "india-jobspy",
    message: "Job discovery is executed by .github/workflows/india-jobs.yml",
  });
}
