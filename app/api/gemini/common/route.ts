import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createSessionId, getSessionCookieName } from "@/lib/gmail";
const MODEL = "gemini-2.5-flash";
function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`Missing environment variable: ${name}`); return value; }
function trim(value: unknown, max = 18000) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function db() { return createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } }); }
async function sessionId() { const store = await cookies(); return store.get(getSessionCookieName())?.value || createSessionId(); }
export async function POST(request: Request) {
  try {
    const body = await request.json() as { job?: { title?: string; company?: string; location?: string; type?: string; description?: string }; contacts?: Array<{ name?: string; title?: string; email?: string }> };
    const job = body.job ?? {}; const contacts = Array.isArray(body.contacts) ? body.contacts.slice(0, 10) : [];
    const title = trim(job.title, 300), company = trim(job.company, 300), description = trim(job.description, 20000);
    if (!title || !company || !contacts.length) return NextResponse.json({ error: "Job and at least one contact are required." }, { status: 400 });
    const id = await sessionId(); const { data: profile, error } = await db().from("candidate_profiles").select("cv_path,cv_name").eq("session_id", id).maybeSingle(); if (error) throw error;
    if (!profile?.cv_path) return NextResponse.json({ error: "Upload your CV as a PDF in Profile first." }, { status: 400 });
    const { data: cv, error: cvError } = await db().storage.from("candidate-cvs").download(profile.cv_path); if (cvError || !cv) throw cvError || new Error("Unable to read CV");
    const cvBytes = Buffer.from(await cv.arrayBuffer());
    const prompt = `You are JobApp's application assistant. Use ONLY the attached PDF CV as the candidate's source of truth. Write one common, professional outreach email for HR/recruitment contacts about the job below. It will be sent to all listed recipients using BCC, so do not address any individual by name. Do not mention BCC or the recipient list. Never invent qualifications or experience. Keep it human and under 220 words. Return JSON exactly: subject, body.\n\nJob: ${title} at ${company}\nLocation: ${trim(job.location,200) || "Goa"}\nType: ${trim(job.type,100) || "Not provided"}\nDescription: ${description || "Not provided"}\nContacts: ${contacts.map((c) => `${trim(c.name,120)} — ${trim(c.title,160)}`).join("; ")}`;
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(required("GEMINI_API_KEY"))}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: "application/pdf", data: cvBytes.toString("base64") } }] }], generationConfig: { temperature: 0.4, responseMimeType: "application/json", responseSchema: { type: "OBJECT", properties: { subject: { type: "STRING" }, body: { type: "STRING" } }, required: ["subject", "body"] } } }), cache: "no-store" });
    if (!response.ok) return NextResponse.json({ error: "Gemini generation failed" }, { status: 502 });
    const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }; const output = data.candidates?.[0]?.content?.parts?.[0]?.text; if (!output) return NextResponse.json({ error: "Gemini returned no content" }, { status: 502 });
    const generated = JSON.parse(output) as { subject?: string; body?: string }; if (!generated.subject || !generated.body) return NextResponse.json({ error: "Gemini returned an incomplete email" }, { status: 502 });
    return NextResponse.json({ subject: generated.subject.trim().slice(0,300), body: generated.body.trim().slice(0,8000), cvName: profile.cv_name });
  } catch (error) { console.error("Common email generation error", error); return NextResponse.json({ error: "Unable to generate common email" }, { status: 500 }); }
}
