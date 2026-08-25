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

async function getSession() {
  const store = await cookies();
  let id = store.get(getSessionCookieName())?.value;
  const isNew = !id;
  if (!id) id = createSessionId();
  return { id, isNew };
}

function setSessionCookie(response: NextResponse, id: string) {
  response.cookies.set(getSessionCookieName(), id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export async function GET() {
  try {
    const { id, isNew } = await getSession();
    const { data, error } = await db().from("candidate_profiles").select("name,experience,skills,cv_name,cv_path,cv_uploaded_at").eq("session_id", id).maybeSingle();
    if (error) return NextResponse.json({ error: "Unable to load profile" }, { status: 500 });
    const response = NextResponse.json({ profile: data ?? null });
    if (isNew) setSessionCookie(response, id);
    return response;
  } catch (error) {
    console.error("Profile GET failed", error);
    return NextResponse.json({ error: "Unable to load profile" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { id, isNew } = await getSession();
    const form = await request.formData();
    const name = String(form.get("name") ?? "").trim().slice(0, 160);
    const experience = String(form.get("experience") ?? "").trim().slice(0, 5000);
    const skills = String(form.get("skills") ?? "").trim().slice(0, 5000);
    const file = form.get("cv");

    let cvName: string | null = null;
    let cvPath: string | null = null;
    let cvUploadedAt: string | null = null;
    const client = db();

    const { data: existing } = await client.from("candidate_profiles").select("cv_path").eq("session_id", id).maybeSingle();

    if (file instanceof File && file.size > 0) {
      if (file.type !== "application/pdf" || !file.name.toLowerCase().endsWith(".pdf")) {
        return NextResponse.json({ error: "CV must be a PDF file." }, { status: 400 });
      }
      if (file.size > 10 * 1024 * 1024) {
        return NextResponse.json({ error: "CV must be 10 MB or smaller." }, { status: 400 });
      }

      cvName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180);
      cvPath = `${id}/${crypto.randomUUID()}.pdf`;
      const bytes = Buffer.from(await file.arrayBuffer());
      const { error: uploadError } = await client.storage.from("candidate-cvs").upload(cvPath, bytes, {
        contentType: "application/pdf",
        upsert: false,
      });
      if (uploadError) throw uploadError;
      cvUploadedAt = new Date().toISOString();

      if (existing?.cv_path) await client.storage.from("candidate-cvs").remove([existing.cv_path]);
    } else if (existing?.cv_path) {
      const { data: current } = await client.from("candidate_profiles").select("cv_name,cv_path,cv_uploaded_at").eq("session_id", id).maybeSingle();
      cvName = current?.cv_name ?? null;
      cvPath = current?.cv_path ?? null;
      cvUploadedAt = current?.cv_uploaded_at ?? null;
    }

    const now = new Date().toISOString();
    const { data, error } = await client.from("candidate_profiles").upsert({
      session_id: id,
      name,
      experience,
      skills,
      cv_name: cvName,
      cv_path: cvPath,
      cv_uploaded_at: cvUploadedAt,
      updated_at: now,
    }, { onConflict: "session_id" }).select("name,experience,skills,cv_name,cv_path,cv_uploaded_at").single();

    if (error) throw error;
    const response = NextResponse.json({ profile: data });
    if (isNew) setSessionCookie(response, id);
    return response;
  } catch (error) {
    console.error("Profile POST failed", error);
    return NextResponse.json({ error: "Unable to save profile or CV" }, { status: 500 });
  }
}
