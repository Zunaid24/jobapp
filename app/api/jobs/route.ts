import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createSessionId, getSessionCookieName } from "@/lib/gmail";

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server configuration is missing");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function session() {
  const store = await cookies();
  let id = store.get(getSessionCookieName())?.value;
  if (!id) id = createSessionId();
  return { id, isNew: !store.get(getSessionCookieName()) };
}

const jobs = [
  { id: "hr-manager-company-name", title: "HR Manager", company: "Company Name", location: "Goa", type: "Full-time", match: 87, description: "Lead HR operations, employee engagement, hiring and people processes for a growing team." },
  { id: "people-operations-remote-company", title: "People Operations Specialist", company: "Remote Company", location: "Remote", type: "Full-time", match: 84, description: "Own people operations, onboarding, employee support and HR process improvements for a distributed team." },
  { id: "talent-acquisition-goa-startup", title: "Talent Acquisition Executive", company: "Goa Startup", location: "Goa", type: "Full-time", match: 81, description: "Manage sourcing, candidate screening, interview coordination and hiring operations." },
  { id: "hr-business-partner-remote", title: "HR Business Partner", company: "Global Remote Co", location: "Remote", type: "Full-time", match: 79, description: "Partner with managers on people strategy, performance and employee experience." },
  { id: "recruiter-remote", title: "Technical Recruiter", company: "Remote Labs", location: "Remote", type: "Contract", match: 76, description: "Source and assess candidates for international technology roles." },
];

export async function GET(request: Request) {
  try {
    const { id, isNew } = await session();
    const url = new URL(request.url);
    const location = url.searchParams.get("location") === "Remote" ? "Remote" : "Goa";
    const list = jobs.filter((job) => job.location === location).slice(0, location === "Remote" ? 20 : 50);
    const response = NextResponse.json({ jobs: list, remoteDailyLimit: 20 });
    if (isNew) response.cookies.set(getSessionCookieName(), id, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
    return response;
  } catch (error) {
    console.error("Jobs endpoint failed", error);
    return NextResponse.json({ error: "Unable to load jobs" }, { status: 500 });
  }
}
