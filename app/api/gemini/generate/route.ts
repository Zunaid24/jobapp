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
    const body = await request.json() as { job?: { title?: string; company?: string; location?: string; type?: string; description?: string; contact_email?: string; decision_maker_name?: string; decision_maker_title?: string } };
    const job = body.job ?? {};
    const title = trim(job.title, 300), company = trim(job.company, 300), location = trim(job.location, 200), type = trim(job.type, 100), description = trim(job.description, 20000);
    const recipient = trim(job.contact_email, 320), decisionMaker = trim(job.decision_maker_name, 200), decisionTitle = trim(job.decision_maker_title, 200);
    if (!title || !company || !recipient) return NextResponse.json({ error: "Job title, company and decision-maker email are required." }, { status: 400 });

    const id = await sessionId();
    const { data: profile, error: profileError } = await db().from("candidate_profiles").select("cv_path,cv_name").eq("session_id", id).maybeSingle();
    if (profileError) throw profileError;
    if (!profile?.cv_path) return NextResponse.json({ error: "Upload your CV as a PDF in Profile first." }, { status: 400 });
    const { data: cv, error: cvError } = await db().storage.from("candidate-cvs").download(profile.cv_path);
    if (cvError || !cv) throw cvError || new Error("Unable to read CV");
    const cvBytes = Buffer.from(await cv.arrayBuffer());

    const prompt = `You are JobApp's application assistant. Use ONLY the attached PDF CV as the candidate's source of truth. Write a personalized job application email addressed to the decision maker below.

Rules:
- Never invent qualifications, employers, achievements, dates, skills, or experience.
- Mention only evidence supported by the CV and relevant to the job.
- Address the decision maker by name when supplied.
- Keep the email human, concise and professional, under 220 words.
- Do not claim the candidate has applied elsewhere or spoken to the recipient before.
- Return valid JSON with exactly: fitScore, fitReasons, subject, body.
- fitScore is 0-100 based on evidence in the CV against the job.

Decision maker: ${decisionMaker || "Hiring contact"}${decisionTitle ? `, ${decisionTitle}` : ""}
Recipient email: ${recipient}

Job:
Title: ${title}
Company: ${company}
Location: ${location || "Goa"}
Type: ${type || "Not provided"}
Description: ${description || "Not provided"}`;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(required("GEMINI_API_KEY"))}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: "application/pdf", data: cvBytes.toString("base64") } }] }], generationConfig: { temperature: 0.4, responseMimeType: "application/json", responseSchema: { type: "OBJECT", properties: { fitScore: { type: "INTEGER" }, fitReasons: { type: "ARRAY", items: { type: "STRING" } }, subject: { type: "STRING" }, body: { type: "STRING" } }, required: ["fitScore", "fitReasons", "subject", "body"] } } }),
      cache: "no-store",
    });
    if (!response.ok) { console.error("Gemini generation failed", await response.text()); return NextResponse.json({ error: "Gemini generation failed" }, { status: 502 }); }
    const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return NextResponse.json({ error: "Gemini returned no content" }, { status: 502 });
    let generated: { fitScore?: number; fitReasons?: string[]; subject?: string; body?: string };
    try { generated = JSON.parse(text); } catch { return NextResponse.json({ error: "Gemini returned invalid JSON" }, { status: 502 }); }
    if (!generated.subject || !generated.body) return NextResponse.json({ error: "Gemini returned an incomplete application" }, { status: 502 });
    return NextResponse.json({ fitScore: Math.max(0, Math.min(100, Math.round(Number(generated.fitScore ?? 0)))), fitReasons: Array.isArray(generated.fitReasons) ? generated.fitReasons.slice(0, 3).map(String) : [], subject: generated.subject.trim().slice(0, 300), body: generated.body.trim().slice(0, 8000), cvName: profile.cv_name, recipient });
  } catch (error) {
    console.error("Gemini application generation error", error);
    return NextResponse.json({ error: "Unable to generate application" }, { status: 500 });
  }
}
