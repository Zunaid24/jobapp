import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { exchangeCode, fetchGoogleEmail, getSessionCookieName, saveGmailConnection, verifyOAuthState } from "@/lib/gmail";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error || !code || !state) return NextResponse.redirect(new URL("/?gmail=error", request.url));

  try {
    const verified = verifyOAuthState(state);
    if (!verified) return NextResponse.redirect(new URL("/?gmail=invalid_state", request.url));

    const cookieStore = await cookies();
    const sessionId = cookieStore.get(getSessionCookieName())?.value;
    if (!sessionId || sessionId !== verified.sessionId) {
      return NextResponse.redirect(new URL("/?gmail=invalid_session", request.url));
    }

    const token = await exchangeCode(code);
    const email = await fetchGoogleEmail(token.access_token);
    await saveGmailConnection({
      sessionId,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresIn: token.expires_in,
      email,
    });

    return NextResponse.redirect(new URL("/?gmail=connected", request.url));
  } catch (callbackError) {
    console.error("Gmail OAuth callback failed", callbackError);
    return NextResponse.redirect(new URL("/?gmail=error", request.url));
  }
}
