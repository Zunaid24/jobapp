import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { disconnectGmail, getSessionCookieName } from "@/lib/gmail";

export async function POST() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(getSessionCookieName())?.value;
  if (sessionId) await disconnectGmail(sessionId);

  return NextResponse.json({ connected: false });
}
