import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getSessionCookieName } from "@/lib/gmail";

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server configuration is missing");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function sessionId() {
  return (await cookies()).get(getSessionCookieName())?.value ?? null;
}

export async function GET() {
  const session = await sessionId();
  if (!session) return NextResponse.json({ items: [] });
  const { data, error } = await db().from("application_tracker").select("*").eq("session_id", session).order("last_action_at", { ascending: false });
  if (error) return NextResponse.json({ error: "Unable to load tracker" }, { status: 500 });
  return NextResponse.json({ items: data ?? [] });
}

export async function POST(request: Request) {
  const session = await sessionId();
  if (!session) return NextResponse.json({ error: "Session required" }, { status: 401 });
  const body = await request.json();
  if (!body.jobId || !body.jobTitle || !body.company) return NextResponse.json({ error: "jobId, jobTitle and company are required" }, { status: 400 });
  const now = new Date().toISOString();
  const { data, error } = await db().from("application_tracker").upsert({
    session_id: session,
    job_id: String(body.jobId),
    job_title: String(body.jobTitle),
    company: String(body.company),
    location: body.location ? String(body.location) : null,
    status: body.status ? String(body.status) : "Applied",
    subject: body.subject ? String(body.subject).slice(0, 300) : null,
    application_body: body.applicationBody ? String(body.applicationBody).slice(0, 8000) : null,
    applied_at: body.status === "Applied" || body.status === "Follow-up" ? now : null,
    last_action_at: now,
    updated_at: now,
  }, { onConflict: "session_id,job_id" }).select("*").single();
  if (error) return NextResponse.json({ error: "Unable to update tracker" }, { status: 500 });
  return NextResponse.json({ item: data });
}
