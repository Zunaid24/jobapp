import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createOAuthState, createSessionId, getSessionCookieName, googleAuthorizationUrl } from "@/lib/gmail";

export async function GET(request: Request) {
  try {
    const cookieStore = await cookies();
    let sessionId = cookieStore.get(getSessionCookieName())?.value;
    if (!sessionId) sessionId = createSessionId();

    const origin = new URL(request.url).origin;
    const state = createOAuthState(sessionId);
    const response = NextResponse.redirect(googleAuthorizationUrl(state, origin), { status: 302 });
    response.cookies.set(getSessionCookieName(), sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
    return response;
  } catch (error) {
    console.error("Gmail connect failed", error);
    return new NextResponse("Gmail connection is not configured. Check Google OAuth environment variables and redirect URI.", { status: 500 });
  }
}
