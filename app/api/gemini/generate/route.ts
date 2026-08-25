import { NextResponse } from "next/server";

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

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      candidate?: { name?: string; experience?: string; skills?: string; resume?: string };
      job?: { title?: string; company?: string; location?: string; description?: string };
    };

    const name = trimInput(body.candidate?.name, 200) || "the candidate";
    const experience = trimInput(body.candidate?.experience);
    const skills = trimInput(body.candidate?.skills);
    const resume = trimInput(body.candidate?.resume);
    const title = trimInput(body.job?.title, 300);
    const company = trimInput(body.job?.company, 300);
    const location = trimInput(body.job?.location, 200);
    const description = trimInput(body.job?.description);

    if (!title || !company) {
      return NextResponse.json({ error: "job.title and job.company are required" }, { status: 400 });
    }

    const prompt = `You are JobApp's application-writing assistant. Write a concise, truthful job application email personalized to the candidate and the specific job.

Rules:
- Do not invent qualifications, employers, achievements, dates, or skills.
- Only use facts supplied in the candidate information.
- Keep the email professional, warm, and human; avoid generic AI language.
- Mention the role and company naturally.
- Keep the body under 220 words.
- Return valid JSON with exactly these keys: subject, body.
- Do not wrap the JSON in markdown fences.

Candidate:
Name: ${name}
Experience: ${experience || "Not provided"}
Skills: ${skills || "Not provided"}
Resume/Profile: ${resume || "Not provided"}

Job:
Title: ${title}
Company: ${company}
Location: ${location || "Not provided"}
Description: ${description || "Not provided"}`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(required("GEMINI_API_KEY"))}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.7,
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                subject: { type: "STRING" },
                body: { type: "STRING" },
              },
              required: ["subject", "body"],
            },
          },
        }),
        cache: "no-store",
      },
    );

    if (!response.ok) {
      const detail = await response.text();
      console.error("Gemini generation failed", detail);
      return NextResponse.json({ error: "Gemini generation failed" }, { status: 502 });
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return NextResponse.json({ error: "Gemini returned no content" }, { status: 502 });

    let generated: { subject?: string; body?: string };
    try {
      generated = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "Gemini returned invalid JSON" }, { status: 502 });
    }

    if (!generated.subject || !generated.body) {
      return NextResponse.json({ error: "Gemini returned an incomplete application" }, { status: 502 });
    }

    return NextResponse.json({
      subject: generated.subject.trim().slice(0, 300),
      body: generated.body.trim().slice(0, 8000),
      model: MODEL,
    });
  } catch (error) {
    console.error("Gemini application generation error", error);
    return NextResponse.json({ error: "Unable to generate application" }, { status: 500 });
  }
}
