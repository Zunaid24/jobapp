import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getGmailConnection, getSessionCookieName } from "@/lib/gmail";

export async function GET() {
  const sessionId = (await cookies()).get(getSessionCookieName())?.value;
  if (!sessionId) return NextResponse.json({ connected: false });

  const connection = await getGmailConnection(sessionId);
  if (!connection) return NextResponse.json({ connected: false });

  return NextResponse.json({
    connected: true,
    email: connection.email,
    sessionExpiresAt: connection.sessionExpiresAt,
  });
}
