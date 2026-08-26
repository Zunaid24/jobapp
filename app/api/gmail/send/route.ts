import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getGmailConnection, getSessionCookieName } from "@/lib/gmail";
function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`Missing environment variable: ${name}`); return value; }
function encodeBase64Url(value: Buffer | string) { return Buffer.isBuffer(value) ? value.toString("base64url") : Buffer.from(value, "utf8").toString("base64url"); }
function db() { return createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } }); }
export async function POST(request: Request) {
  try {
    const sessionId = (await cookies()).get(getSessionCookieName())?.value; if (!sessionId) return NextResponse.json({ error: "Gmail connection required" }, { status: 401 });
    const connection = await getGmailConnection(sessionId); if (!connection) return NextResponse.json({ error: "Gmail connection expired. Connect Gmail again." }, { status: 401 });
    const body = await request.json() as { to?: string; bcc?: string[]; subject?: string; text?: string };
    const recipients = body.bcc?.length ? body.bcc : body.to ? [body.to] : []; const valid = recipients.map((x) => x.trim().toLowerCase()).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
    if (!valid.length || !body.subject || !body.text) return NextResponse.json({ error: "A valid recipient, subject and text are required" }, { status: 400 });
    const { data: profile, error: profileError } = await db().from("candidate_profiles").select("cv_path,cv_name").eq("session_id", sessionId).maybeSingle(); if (profileError) throw profileError; if (!profile?.cv_path) return NextResponse.json({ error: "Upload a PDF CV before sending." }, { status: 400 });
    const { data: cv, error: cvError } = await db().storage.from("candidate-cvs").download(profile.cv_path); if (cvError || !cv) throw cvError || new Error("Unable to read CV");
    const attachment = Buffer.from(await cv.arrayBuffer()); const filename = (profile.cv_name || "CV.pdf").replace(/[^a-zA-Z0-9._-]/g, "_"); const boundary = `JobAppBoundary_${crypto.randomUUID().replaceAll("-", "")}`;
    const headers = valid.length > 1 ? [`To: undisclosed-recipients:;`, `Bcc: ${valid.join(", ")}`] : [`To: ${valid[0]}`];
    const message = [...headers, "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary=\"${boundary}\"`, `Subject: ${body.subject.replace(/[\r\n]/g, " ").slice(0, 300)}`, "", `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "", body.text, "", `--${boundary}`, `Content-Type: application/pdf; name=\"${filename}\"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename=\"${filename}\"`, "", attachment.toString("base64").match(/.{1,76}/g)?.join("\r\n") || "", `--${boundary}--`, ""].join("\r\n");
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", headers: { Authorization: `Bearer ${connection.accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ raw: encodeBase64Url(Buffer.from(message, "utf8")) }), cache: "no-store" });
    if (!response.ok) { console.error("Gmail send failed", await response.text()); return NextResponse.json({ error: "Gmail send failed" }, { status: response.status }); }
    return NextResponse.json({ sent: true, attachment: filename, recipients: valid.length, bcc: valid.length > 1 });
  } catch (error) { console.error("Gmail send error", error); return NextResponse.json({ error: "Unable to send email" }, { status: 500 }); }
}
