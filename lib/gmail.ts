import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

const SESSION_COOKIE = "jobapp_session";
const SESSION_HOURS = 12;
const OAUTH_SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/userinfo.email"];

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function supabaseAdmin() {
  return createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { autoRefreshToken: false, persistSession: false } });
}

function encryptionKey() {
  const key = Buffer.from(required("GMAIL_TOKEN_ENCRYPTION_KEY"), "hex");
  if (key.length !== 32) throw new Error("GMAIL_TOKEN_ENCRYPTION_KEY must be 64 hex characters");
  return key;
}

export function encryptSecret(value: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptSecret(value: string) {
  const [ivText, tagText, encryptedText] = value.split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8");
}

export function getSessionCookieName() { return SESSION_COOKIE; }
export function createSessionId() { return crypto.randomBytes(32).toString("base64url"); }
export function sessionExpiresAt() { return Date.now() + SESSION_HOURS * 60 * 60 * 1000; }

export function createOAuthState(sessionId: string) {
  const payload = Buffer.from(JSON.stringify({ sessionId, issuedAt: Date.now() })).toString("base64url");
  const signature = crypto.createHmac("sha256", required("SESSION_SECRET")).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyOAuthState(state: string) {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) return null;
  const expected = crypto.createHmac("sha256", required("SESSION_SECRET")).update(payload).digest("base64url");
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sessionId: string; issuedAt: number };
  if (Date.now() - data.issuedAt > 10 * 60 * 1000) return null;
  return data;
}

export function googleAuthorizationUrl(state: string, origin?: string) {
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${origin ?? "https://${process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL}"}/api/gmail/callback`;
  if (!redirectUri || redirectUri.includes("undefined")) throw new Error("Google redirect URI is not configured");
  const params = new URLSearchParams({ client_id: required("GOOGLE_CLIENT_ID"), redirect_uri: redirectUri, response_type: "code", access_type: "offline", prompt: "consent", scope: OAUTH_SCOPES.join(" "), state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function redirectUri(origin?: string) {
  const value = process.env.GOOGLE_REDIRECT_URI || (origin ? `${origin}/api/gmail/callback` : null);
  if (!value) throw new Error("Google redirect URI is not configured");
  return value;
}

async function googleTokenRequest(params: URLSearchParams) {
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params, cache: "no-store" });
  if (!response.ok) throw new Error(`Google token request failed: ${response.status}`);
  return response.json() as Promise<{ access_token: string; refresh_token?: string; expires_in: number }>;
}

export async function exchangeCode(code: string, origin?: string) {
  return googleTokenRequest(new URLSearchParams({ code, client_id: required("GOOGLE_CLIENT_ID"), client_secret: required("GOOGLE_CLIENT_SECRET"), redirect_uri: redirectUri(origin), grant_type: "authorization_code" }));
}

async function refreshAccessToken(refreshToken: string) {
  return googleTokenRequest(new URLSearchParams({ refresh_token: refreshToken, client_id: required("GOOGLE_CLIENT_ID"), client_secret: required("GOOGLE_CLIENT_SECRET"), grant_type: "refresh_token" }));
}

export async function fetchGoogleEmail(accessToken: string) {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  if (!response.ok) return null;
  return ((await response.json()) as { email?: string }).email ?? null;
}

export async function saveGmailConnection(input: { sessionId: string; accessToken: string; refreshToken?: string | null; expiresIn: number; email: string | null }) {
  const db = supabaseAdmin();
  const { error } = await db.from("gmail_connections").upsert({ session_id: input.sessionId, email: input.email, access_token_encrypted: encryptSecret(input.accessToken), refresh_token_encrypted: input.refreshToken ? encryptSecret(input.refreshToken) : null, access_token_expires_at: new Date(Date.now() + input.expiresIn * 1000).toISOString(), session_expires_at: new Date(sessionExpiresAt()).toISOString(), updated_at: new Date().toISOString() }, { onConflict: "session_id" });
  if (error) throw error;
}

export async function getGmailConnection(sessionId: string) {
  const db = supabaseAdmin();
  const { data, error } = await db.from("gmail_connections").select("*").eq("session_id", sessionId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const sessionExpiry = new Date(data.session_expires_at).getTime();
  if (sessionExpiry <= Date.now()) { await db.from("gmail_connections").delete().eq("session_id", sessionId); return null; }
  let accessToken = decryptSecret(data.access_token_encrypted);
  let accessTokenExpiry = new Date(data.access_token_expires_at).getTime();
  const refreshToken = data.refresh_token_encrypted ? decryptSecret(data.refresh_token_encrypted) : null;
  if (accessTokenExpiry <= Date.now() + 60_000) {
    if (!refreshToken) return null;
    const refreshed = await refreshAccessToken(refreshToken);
    accessToken = refreshed.access_token;
    accessTokenExpiry = Date.now() + refreshed.expires_in * 1000;
    await db.from("gmail_connections").update({ access_token_encrypted: encryptSecret(accessToken), access_token_expires_at: new Date(accessTokenExpiry).toISOString(), updated_at: new Date().toISOString() }).eq("session_id", sessionId);
  }
  return { sessionId, email: data.email, accessToken, refreshToken, accessTokenExpiresAt: accessTokenExpiry, sessionExpiresAt: sessionExpiry };
}

export async function disconnectGmail(sessionId: string) {
  const { error } = await supabaseAdmin().from("gmail_connections").delete().eq("session_id", sessionId);
  if (error) throw error;
}

export { SESSION_HOURS };
