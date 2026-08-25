import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getGmailConnection, getSessionCookieName } from "@/lib/gmail";

function encodeBase64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

export async function POST(request: Request) {
  const sessionId = (await cookies()).get(getSessionCookieName())?.value;
  if (!sessionId) return NextResponse.json({ error: "Gmail connection required" }, { status: 401 });

  // Server-side enforcement: an expired/disconnected 12-hour session can never send.
  const connection = await getGmailConnection(sessionId);
  if (!connection) return NextResponse.json({ error: "Gmail connection expired. Connect Gmail again." }, { status: 401 });

  const body = (await request.json()) as { to?: string; subject?: string; text?: string };
  if (!body.to || !body.subject || !body.text) {
    return NextResponse.json({ error: "to, subject and text are required" }, { status: 400 });
  }

  const rawMessage = [
    `To: ${body.to}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    `Subject: ${body.subject}`,
    "",
    body.text,
  ].join("\r\n");

  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: encodeBase64Url(rawMessage) }),
    cache: "no-store",
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error("Gmail send failed", detail);
    return NextResponse.json({ error: "Gmail send failed" }, { status: response.status });
  }

  return NextResponse.json({ sent: true });
}
