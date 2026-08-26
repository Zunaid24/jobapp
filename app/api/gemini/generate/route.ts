import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createSessionId, getSessionCookieName } from "@/lib/gmail";

const MODEL = "gemini-2.5-flash";
const MAX_INPUT_LENGTH = 12000;

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function trimInput(value: unknown, max = MAX_INPUT_LENGTH) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function db() {
  return createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } });
}

async function getSessionId() {
  const store = await cookies();
  return store.get(getSessionCookieName())?.value || createSessionId();
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      candidate?: { name?: string; experience?: string; skills?: string };
      job?: { title?: string; company?: string; location?: string; description?: string };
    };

    const sessionId = await getSessionId();
    const { data: profile, error: profileError } = await db().from("candidate_profiles").select("name,experience,skills,cv_path,cv_name").eq("session_id", sessionId).maybeSingle();
    if (profileError) throw profileError;
    if (!profile?.cv_path) return NextResponse.json({ error: "Upload your CV as a PDF in Profile before applying." }, { status: 400 });

    const name = trimInput(profile.name || body.candidate?.name, 200) || "the candidate";
    const experience = trimInput(profile.experience || body.candidate?.experience);
    const skills = trimInput(profile.skills || body.candidate?.skills);
    const title = trimInput(body.job?.title, 300);
    const company = trimInput(body.job?.company, 300);
    const location = trimInput(body.job?.location, 200);
    const description = trimInput(body.job?.description, 18000);

    if (!title || !company) return NextResponse.json({ error: "job.title and job.company are required" }, { status: 400 });

    const { data: cv, error: cvError } = await db().storage.from("candidate-cvs").download(profile.cv_path);
    if (cvError || !cv) throw cvError || new Error("Unable to read CV");
    const cvBytes = Buffer.from(await cv.arrayBuffer());

    const prompt = `You are JobApp's application assistant. Analyze the attached candidate CV and the job description, then produce a truthful fit assessment and personalized application email.

Rules:
- Treat the attached CV and candidate profile as the source of truth.
- Never invent qualifications, employers, achievements, dates, skills, or experience.
- Fit score must be 0-100 and reflect actual evidence in the CV against the job.
- Give up to 3 short reasons for the score.
- Keep the email professional, warm, specific, and human.
- Keep the email body under 220 words.
- Return valid JSON with exactly: fitScore, fitReasons, subject, body.

Candidate profile:
Name: ${name}
Experience: ${experience || "Not provided"}
Skills: ${skills || "Not provided"}
CV filename: ${profile.cv_name || "candidate.pdf"}

Job:
Title: ${title}
Company: ${company}
Location: ${location || "Not provided"}
Description: ${description || "Not provided"}`;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(required("GEMINI_API_KEY"))}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [
          { text: prompt },
          { inlineData: { mimeType: "application/pdf", data: cvBytes.toString("base64") } },
        ] }],
        generationConfig: {
          temperature: 0.4,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              fitScore: { type: "INTEGER" },
              fitReasons: { type: "ARRAY", items: { type: "STRING" } },
              subject: { type: "STRING" },
              body: { type: "STRING" },
            },
            required: ["fitScore", "fitReasons", "subject", "body"],
          },
        },
      }),
      cache: "no-store",
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("Gemini generation failed", detail);
      return NextResponse.json({ error: "Gemini generation failed" }, { status: 502 });
    }

    const data = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return NextResponse.json({ error: "Gemini returned no content" }, { status: 502 });

    let generated: { fitScore?: number; fitReasons?: string[]; subject?: string; body?: string };
    try { generated = JSON.parse(text); } catch { return NextResponse.json({ error: "Gemini returned invalid JSON" }, { status: 502 }); }

    if (!generated.subject || !generated.body) return NextResponse.json({ error: "Gemini returned an incomplete application" }, { status: 502 });

    return NextResponse.json({
      fitScore: Math.max(0, Math.min(100, Math.round(Number(generated.fitScore ?? 0)))),
      fitReasons: Array.isArray(generated.fitReasons) ? generated.fitReasons.slice(0, 3).map((item) => String(item).trim()).filter(Boolean) : [],
      subject: generated.subject.trim().slice(0, 300),
      body: generated.body.trim().slice(0, 8000),
      cvName: profile.cv_name,
      model: MODEL,
    });
  } catch (error) {
    console.error("Gemini application generation error", error);
    return NextResponse.json({ error: "Unable to generate application" }, { status: 500 });
  }
}
