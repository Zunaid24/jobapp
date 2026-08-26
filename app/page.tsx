"use client";

import { useEffect, useMemo, useState } from "react";

type GmailStatus = { connected: boolean; email?: string | null; sessionExpiresAt?: number };
type Job = { id: string; title: string; company: string; location: string; type: string; match: number; description: string; apply_url?: string | null; contact_email?: string | null; decision_maker_name?: string | null; decision_maker_title?: string | null; source?: string | null };
type TrackerItem = { id: string; job_id: string; job_title: string; company: string; location: string | null; status: string; subject: string | null; application_body: string | null; last_action_at: string };
type Profile = { cvName: string | null; cvUploadedAt: string | null };
type Draft = { subject: string; body: string; fitScore: number; fitReasons: string[]; cvName?: string | null };

const emptyProfile: Profile = { cvName: null, cvUploadedAt: null };
function formatRemaining(expiresAt?: number) { if (!expiresAt) return ""; const remaining = Math.max(0, expiresAt - Date.now()); return `${Math.floor(remaining / 3600000)}h ${Math.floor((remaining % 3600000) / 60000)}m`; }
function formatDate(value?: string | null) { return value ? new Date(value).toLocaleDateString() : ""; }

export default function Home() {
  const [location, setLocation] = useState<"Goa" | "Remote">("Goa");
  const [tab, setTab] = useState<"Jobs" | "Tracker" | "Profile">("Jobs");
  const [gmail, setGmail] = useState<GmailStatus>({ connected: false });
  const [remaining, setRemaining] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [tracker, setTracker] = useState<TrackerItem[]>([]);
  const [profile, setProfile] = useState<Profile>(emptyProfile);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");

  async function loadStatus() { const response = await fetch("/api/gmail/status", { cache: "no-store" }); if (!response.ok) return; const status = await response.json() as GmailStatus; setGmail(status); setRemaining(formatRemaining(status.sessionExpiresAt)); }
  async function loadJobs(nextLocation = location) { const response = await fetch(`/api/jobs?location=${nextLocation}`, { cache: "no-store" }); if (!response.ok) return; const data = await response.json(); setJobs(data.jobs ?? []); }
  async function loadTracker() { const response = await fetch("/api/tracker", { cache: "no-store" }); if (!response.ok) return; const data = await response.json(); setTracker(data.items ?? []); }
  async function loadProfile() { const response = await fetch("/api/profile", { cache: "no-store" }); if (!response.ok) return; const data = await response.json(); if (data.profile) setProfile({ cvName: data.profile.cv_name ?? null, cvUploadedAt: data.profile.cv_uploaded_at ?? null }); }

  useEffect(() => { loadStatus(); loadJobs(); loadTracker(); loadProfile(); }, []);
  useEffect(() => { const interval = window.setInterval(() => { setRemaining(formatRemaining(gmail.sessionExpiresAt)); if (gmail.sessionExpiresAt && gmail.sessionExpiresAt <= Date.now()) loadStatus(); }, 30000); return () => window.clearInterval(interval); }, [gmail.sessionExpiresAt]);
  useEffect(() => { loadJobs(location); }, [location]);
  useEffect(() => { if (tab === "Tracker") loadTracker(); if (tab === "Profile") loadProfile(); }, [tab]);
  useEffect(() => { const value = new URLSearchParams(window.location.search).get("gmail"); if (value === "connected") { setNotice("Gmail connected for the next 12 hours."); loadStatus(); window.history.replaceState({}, "", "/"); } else if (value && value !== "connected") { setNotice(`Gmail connection ${value.replaceAll("_", " ")}.`); window.history.replaceState({}, "", "/"); } }, []);

  const counts = useMemo(() => ({ applied: tracker.filter((x) => x.status === "Applied").length, interview: tracker.filter((x) => x.status === "Interview").length, followup: tracker.filter((x) => x.status === "Follow-up").length }), [tracker]);

  async function generateEmail(job: Job) {
    if (!profile.cvName) { setNotice("Upload your PDF CV in Profile before generating an application email."); setTab("Profile"); return; }
    if (!job.contact_email) { setNotice("This job does not have a decision-maker email address."); return; }
    setSelectedJob(job); setDraft(null); setLoading(true); setNotice("");
    try {
      const response = await fetch("/api/gemini/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to generate email");
      setDraft({ subject: data.subject, body: data.body, fitScore: Number(data.fitScore ?? 0), fitReasons: data.fitReasons ?? [], cvName: data.cvName });
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to generate email"); } finally { setLoading(false); }
  }

  async function sendEmail(status: "Applied" | "Follow-up") {
    if (!selectedJob || !draft || !gmail.connected) return;
    setLoading(true); setNotice("");
    try {
      const response = await fetch("/api/gmail/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: selectedJob.contact_email, subject: draft.subject, text: draft.body }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Unable to send email");
      const trackerResponse = await fetch("/api/tracker", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: selectedJob.id, jobTitle: selectedJob.title, company: selectedJob.company, location: selectedJob.location, status, subject: draft.subject, applicationBody: draft.body }) });
      if (!trackerResponse.ok) throw new Error("Email sent, but Tracker could not be updated.");
      await loadTracker(); setSelectedJob(null); setDraft(null); setNotice(status === "Applied" ? "Application email sent with your CV and added to Tracker." : "Follow-up sent and Tracker updated.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to send email"); } finally { setLoading(false); }
  }

  async function uploadCv(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    if (file.type !== "application/pdf" || !file.name.toLowerCase().endsWith(".pdf")) { setNotice("Please upload your CV as a PDF file."); return; }
    if (file.size > 10 * 1024 * 1024) { setNotice("CV must be 10 MB or smaller."); return; }
    setLoading(true); setNotice("");
    try {
      const form = new FormData(); form.append("cv", file);
      const response = await fetch("/api/profile", { method: "POST", body: form }); const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to upload CV");
      setProfile({ cvName: data.profile?.cv_name ?? file.name, cvUploadedAt: data.profile?.cv_uploaded_at ?? new Date().toISOString() }); setNotice("CV uploaded and saved securely in Supabase.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to upload CV"); } finally { setLoading(false); }
  }

  async function disconnect() { await fetch("/api/gmail/disconnect", { method: "POST" }); setGmail({ connected: false }); setRemaining(""); }

  return <main className="app-shell">
    <header className="topbar"><div><span className="eyebrow">JOBAPP</span><h1>Find your next role.</h1></div><button className="icon-button" aria-label="Open menu">☰</button></header>
    <section className={gmail.connected ? "gmail-card connected" : "gmail-card"}><div><div className="status-line"><span className={gmail.connected ? "status-dot" : "status-dot offline"} /><strong>{gmail.connected ? "Gmail Connected" : "Gmail Not Connected"}</strong></div>{gmail.connected ? <p>{gmail.email ?? "Gmail account"} · Session expires in {remaining || "12h"}</p> : <p>Connect Gmail to enable sending application emails.</p>}</div>{gmail.connected ? <button className="secondary-button" onClick={disconnect}>Disconnect</button> : <a className="primary-button" href="/api/gmail/connect">Connect Gmail</a>}</section>
    {notice && <div className="notice" role="status">{notice}</div>}
    {tab === "Jobs" && <><div className="switcher" role="tablist" aria-label="Job location">{(["Goa", "Remote"] as const).map((item) => <button key={item} className={location === item ? "active" : ""} onClick={() => setLocation(item)}>{item}</button>)}</div><section className="jobs-section"><div className="section-heading"><div><span className="eyebrow">DISCOVER</span><h2>{location} jobs</h2></div><span className="job-count">{jobs.length} matching</span></div><div className="job-list">{jobs.map((job) => <article className="job-card" key={job.id}><div className="job-card-top"><div><h3>{job.title}</h3><p>{job.company}</p></div><span className="match">{job.match}%</span></div><div className="job-meta"><span>{job.location}</span><span>·</span><span>{job.type}</span></div><p className="job-summary">{job.description || "Job details available from the source."}</p><div className="decision-maker"><strong>Decision maker</strong><span>{job.decision_maker_name || "Contact"}{job.decision_maker_title ? ` · ${job.decision_maker_title}` : ""}</span><span className={job.contact_email ? "contact-email" : "contact-email muted"}>{job.contact_email || "Email unavailable"}</span></div><div className="actions"><a className={`secondary-button ${!job.apply_url ? "disabled-link" : ""}`} href={job.apply_url || undefined} target="_blank" rel="noreferrer" aria-disabled={!job.apply_url}>Apply on company page</a><button className="primary-button" disabled={!job.contact_email || !profile.cvName} onClick={() => generateEmail(job)}>Generate Email</button></div>{!job.apply_url && <small className="disabled-note">Company application link unavailable.</small>}{job.apply_url && <small className="disabled-note">Opens the job application page in a new tab.</small>}{!job.contact_email ? <small className="disabled-note">No decision-maker email available.</small> : !profile.cvName && <small className="disabled-note">Upload a PDF CV in Profile to generate an email.</small>}</article>)}{!jobs.length && <div className="empty-state">No jobs found for this location yet. The daily Goa collection may still be running.</div>}</div></section></>}
    {tab === "Tracker" && <section className="tracker-section"><div className="section-heading"><div><span className="eyebrow">TRACKER</span><h2>Your applications</h2></div><span className="job-count">{tracker.length} total</span></div><div className="tracker-summary"><div><strong>{counts.applied}</strong><span>Applied</span></div><div><strong>{counts.interview}</strong><span>Interview</span></div><div><strong>{counts.followup}</strong><span>Follow-ups</span></div></div><div className="job-list">{tracker.map((item) => <article className="job-card tracker-card" key={item.id}><div className="job-card-top"><div><h3>{item.job_title}</h3><p>{item.company}</p></div><span className="status-pill">{item.status}</span></div><div className="job-meta"><span>{item.location || "Remote"}</span><span>·</span><span>{formatDate(item.last_action_at)}</span></div>{item.status === "Applied" && gmail.connected && item.application_body && <button className="secondary-button full-button" onClick={() => { setNotice("Open the job card from Jobs to generate a new personalized email."); setTab("Jobs"); }}>Prepare follow-up</button>}</article>)}{!tracker.length && <div className="empty-state">Applications you send will appear here.</div>}</div></section>}
    {tab === "Profile" && <section className="profile-section"><span className="eyebrow">PROFILE</span><h2>Your CV</h2><p className="profile-help">Your CV is the only candidate information JobApp needs. It is stored securely in Supabase and used by Gemini when preparing applications.</p><div className="cv-upload-card"><div><strong>{profile.cvName ? "CV uploaded" : "No CV uploaded"}</strong><p>{profile.cvName ? `${profile.cvName}${profile.cvUploadedAt ? ` · Last uploaded ${formatDate(profile.cvUploadedAt)}` : ""}` : "PDF only · maximum 10 MB"}</p></div><label className="upload-button">{profile.cvName ? "Upload New CV" : "Upload CV"}<input type="file" accept="application/pdf,.pdf" onChange={uploadCv} disabled={loading} /></label></div><p className="profile-help">Upload a new PDF anytime to replace the current CV. The latest upload date is shown above.</p></section>}
    <nav className="bottom-nav" aria-label="Primary navigation">{(["Jobs", "Tracker", "Profile"] as const).map((item) => <button key={item} className={tab === item ? "nav-active" : ""} onClick={() => setTab(item)}>{item === "Jobs" ? "⌂" : item === "Tracker" ? "▣" : "♙"}<span>{item}</span></button>)}</nav>
    {selectedJob && <div className="modal-backdrop" onClick={() => { if (!loading) { setSelectedJob(null); setDraft(null); } }}><div className="modal" onClick={(e) => e.stopPropagation()}>{!draft ? <><span className="eyebrow">GENERATING</span><h2>{loading ? "Preparing email..." : "Application email"}</h2><p>{selectedJob.decision_maker_name || "Decision maker"}{selectedJob.decision_maker_title ? ` · ${selectedJob.decision_maker_title}` : ""}</p><p>{selectedJob.contact_email}</p></> : <><span className="eyebrow">REVIEW BEFORE SENDING</span><h2>Personalized application</h2><div className="match-panel"><span className="match">{draft.fitScore}%</span><div><strong>Gemini fit score</strong>{draft.fitReasons.map((reason, index) => <p key={index}>• {reason}</p>)}</div></div><p className="attachment-note">CV attachment: <strong>{draft.cvName || profile.cvName}</strong></p><label>Subject<input value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} /></label><label>Message<textarea className="message-box" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} /></label><div className="modal-actions"><button className="secondary-button" onClick={() => { setSelectedJob(null); setDraft(null); }}>Cancel</button><button className="primary-button" disabled={!gmail.connected || loading} onClick={() => sendEmail("Applied")}>{!gmail.connected ? "Connect Gmail to Send" : loading ? "Sending..." : "Send Application"}</button></div>{!gmail.connected && <small className="disabled-note">Gmail must be connected within the 12-hour session before sending.</small>}</>}</div></div>}
  </main>;
}
