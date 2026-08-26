"use client";

import { useEffect, useMemo, useState } from "react";

type GmailStatus = { connected: boolean; email?: string | null; sessionExpiresAt?: number };
type DecisionMaker = { id: string; company_id: string; name: string; title?: string | null; email?: string | null; linkedin_url?: string | null };
type Company = { id: string; name: string; website?: string | null; domain?: string | null; linkedin_url?: string | null; location?: string | null; industry?: string | null; description?: string | null };
type Job = { id: string; title: string; company: string; location: string; type: string; match: number; description: string; apply_url?: string | null; posted_at?: string | null; company_id?: string | null; company_details?: Company | null; decision_makers?: DecisionMaker[] };
type TrackerItem = { id: string; job_id: string; job_title: string; company: string; location: string | null; status: string; subject: string | null; application_body: string | null; last_action_at: string };
type Profile = { cvName: string | null; cvUploadedAt: string | null };
type Draft = { subject: string; body: string; fitScore: number; fitReasons: string[]; cvName?: string | null; recipient: string; decisionMakerId: string; jobId: string };

const emptyProfile: Profile = { cvName: null, cvUploadedAt: null };
function formatRemaining(expiresAt?: number) { if (!expiresAt) return ""; const remaining = Math.max(0, expiresAt - Date.now()); return `${Math.floor(remaining / 3600000)}h ${Math.floor((remaining % 3600000) / 60000)}m`; }
function formatDate(value?: string | null) { return value ? new Date(value).toLocaleDateString() : ""; }
function postedLabel(value?: string | null) { if (!value) return "Recent"; const days = Math.floor((Date.now() - new Date(value).getTime()) / 86400000); return days <= 0 ? "Today" : `${days}d ago`; }

export default function Home() {
  const [tab, setTab] = useState<"Jobs" | "Tracker" | "Profile">("Jobs");
  const [gmail, setGmail] = useState<GmailStatus>({ connected: false });
  const [remaining, setRemaining] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [tracker, setTracker] = useState<TrackerItem[]>([]);
  const [profile, setProfile] = useState<Profile>(emptyProfile);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [selectedPerson, setSelectedPerson] = useState<DecisionMaker | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");

  async function loadStatus() { const response = await fetch("/api/gmail/status", { cache: "no-store" }); if (!response.ok) return; const status = await response.json() as GmailStatus; setGmail(status); setRemaining(formatRemaining(status.sessionExpiresAt)); }
  async function loadJobs() { const response = await fetch("/api/jobs?location=Goa", { cache: "no-store" }); if (!response.ok) return; const data = await response.json(); setJobs(data.jobs ?? []); }
  async function loadTracker() { const response = await fetch("/api/tracker", { cache: "no-store" }); if (!response.ok) return; const data = await response.json(); setTracker(data.items ?? []); }
  async function loadProfile() { const response = await fetch("/api/profile", { cache: "no-store" }); if (!response.ok) return; const data = await response.json(); if (data.profile) setProfile({ cvName: data.profile.cv_name ?? null, cvUploadedAt: data.profile.cv_uploaded_at ?? null }); }

  useEffect(() => { loadStatus(); loadJobs(); loadTracker(); loadProfile(); }, []);
  useEffect(() => { const interval = window.setInterval(() => { setRemaining(formatRemaining(gmail.sessionExpiresAt)); if (gmail.sessionExpiresAt && gmail.sessionExpiresAt <= Date.now()) loadStatus(); }, 30000); return () => window.clearInterval(interval); }, [gmail.sessionExpiresAt]);
  useEffect(() => { if (tab === "Tracker") loadTracker(); if (tab === "Profile") loadProfile(); }, [tab]);
  useEffect(() => { const value = new URLSearchParams(window.location.search).get("gmail"); if (value === "connected") { setNotice("Gmail connected for the next 12 hours."); loadStatus(); window.history.replaceState({}, "", "/"); } else if (value && value !== "connected") { setNotice(`Gmail connection ${value.replaceAll("_", " ")}.`); window.history.replaceState({}, "", "/"); } }, []);

  const counts = useMemo(() => ({ applied: tracker.filter((x) => x.status === "Applied").length, interview: tracker.filter((x) => x.status === "Interview").length, followup: tracker.filter((x) => x.status === "Follow-up").length }), [tracker]);

  async function generateEmail(job: Job, person: DecisionMaker) {
    if (!profile.cvName) { setNotice("Upload your PDF CV in Profile before generating an application email."); setTab("Profile"); return; }
    if (!person.email) { setNotice("This decision maker does not have an email address."); return; }
    const existing = drafts[person.id];
    if (existing) { setSelectedJob(job); setSelectedPerson(person); setDraft(existing); return; }
    setSelectedJob(job); setSelectedPerson(person); setDraft(null); setLoading(true); setNotice("");
    try {
      const response = await fetch("/api/gemini/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job: { ...job, contact_email: person.email, decision_maker_name: person.name, decision_maker_title: person.title } }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Unable to generate email");
      const next: Draft = { subject: data.subject, body: data.body, fitScore: Number(data.fitScore ?? 0), fitReasons: data.fitReasons ?? [], cvName: data.cvName, recipient: person.email, decisionMakerId: person.id, jobId: job.id };
      setDrafts((current) => ({ ...current, [person.id]: next })); setDraft(next);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to generate email"); setSelectedJob(null); setSelectedPerson(null); } finally { setLoading(false); }
  }

  async function sendEmail() {
    if (!selectedJob || !selectedPerson || !draft || !gmail.connected) return;
    setLoading(true); setNotice("");
    try {
      const response = await fetch("/api/gmail/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to: selectedPerson.email, subject: draft.subject, text: draft.body }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Unable to send email");
      const trackerResponse = await fetch("/api/tracker", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: selectedJob.id, jobTitle: selectedJob.title, company: selectedJob.company, location: selectedJob.location, status: "Applied", subject: draft.subject, applicationBody: draft.body }) });
      if (!trackerResponse.ok) throw new Error("Email sent, but Tracker could not be updated.");
      await loadTracker(); setSelectedJob(null); setSelectedPerson(null); setDraft(null); setNotice("Application email sent with your CV and added to Tracker.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to send email"); } finally { setLoading(false); }
  }

  async function uploadCv(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    if (file.type !== "application/pdf" || !file.name.toLowerCase().endsWith(".pdf")) { setNotice("Please upload your CV as a PDF file."); return; }
    if (file.size > 10 * 1024 * 1024) { setNotice("CV must be 10 MB or smaller."); return; }
    setLoading(true); setNotice("");
    try { const form = new FormData(); form.append("cv", file); const response = await fetch("/api/profile", { method: "POST", body: form }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Unable to upload CV"); setProfile({ cvName: data.profile?.cv_name ?? file.name, cvUploadedAt: data.profile?.cv_uploaded_at ?? new Date().toISOString() }); setNotice("CV uploaded and saved securely in Supabase."); } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to upload CV"); } finally { setLoading(false); }
  }
  async function disconnect() { await fetch("/api/gmail/disconnect", { method: "POST" }); setGmail({ connected: false }); setRemaining(""); }

  return <main className="app-shell">
    <header className="topbar"><div><span className="eyebrow">JOBAPP</span><h1>Find your next role.</h1></div><button className="icon-button" aria-label="Open menu">☰</button></header>
    <section className={gmail.connected ? "gmail-card connected" : "gmail-card"}><div><div className="status-line"><span className={gmail.connected ? "status-dot" : "status-dot offline"} /><strong>{gmail.connected ? "Gmail Connected" : "Gmail Not Connected"}</strong></div>{gmail.connected ? <p>{gmail.email ?? "Gmail account"} · Session expires in {remaining || "12h"}</p> : <p>Connect Gmail to enable sending application emails.</p>}</div>{gmail.connected ? <button className="secondary-button" onClick={disconnect}>Disconnect</button> : <a className="primary-button" href="/api/gmail/connect">Connect Gmail</a>}</section>
    {notice && <div className="notice" role="status">{notice}</div>}
    {tab === "Jobs" && <section className="jobs-section"><div className="section-heading"><div><span className="eyebrow">GOA · LAST 7 DAYS</span><h2>Recent Goa jobs</h2></div><span className="job-count">{jobs.length} matching</span></div><div className="job-list">{jobs.map((job) => <article className="job-card" key={job.id}><div className="job-card-top"><div><h3>{job.title}</h3><p>{job.company}</p></div><span className="match">{postedLabel(job.posted_at)}</span></div><div className="job-meta"><span>{job.location}</span><span>·</span><span>{job.type}</span></div><p className="job-summary">{job.description || "Job details available from the source."}</p><div className="company-panel"><strong>Company</strong><span>{job.company_details?.industry || "Company details"}{job.company_details?.location ? ` · ${job.company_details.location}` : ""}</span>{job.company_details?.website && <a href={job.company_details.website} target="_blank" rel="noreferrer">Company website</a>}{job.company_details?.linkedin_url && <a href={job.company_details.linkedin_url} target="_blank" rel="noreferrer">LinkedIn</a>}</div><div className="apply-row"><a className={`secondary-button ${!job.apply_url ? "disabled-link" : ""}`} href={job.apply_url || undefined} target="_blank" rel="noreferrer" aria-disabled={!job.apply_url}>Apply on company page</a>{!job.apply_url && <small className="disabled-note">Company application link unavailable.</small>}</div><div className="decision-maker-list"><div className="decision-heading"><strong>Hiring contacts</strong><span>{job.decision_makers?.length || 0} found</span></div>{job.decision_makers?.length ? job.decision_makers.map((person) => { const hasDraft = Boolean(drafts[person.id]); return <div className="decision-person" key={person.id}><div><strong>{person.name}</strong><span>{person.title || "Hiring contact"}</span><span className="contact-email">{person.email}</span></div>{person.linkedin_url && <a className="text-link" href={person.linkedin_url} target="_blank" rel="noreferrer">LinkedIn</a>}<button className="primary-button compact" disabled={!person.email || !profile.cvName || loading} onClick={() => generateEmail(job, person)}>{hasDraft ? "View Email" : "Generate Email"}</button></div>; }) : <div className="contact-empty">Decision makers are being enriched from the company details. Refresh after enrichment completes.</div>}</div></article>)}{!jobs.length && <div className="empty-state">No recent Goa jobs are stored yet. Run the daily collection after the latest deployment.</div>}</div></section>}
    {tab === "Tracker" && <section className="tracker-section"><div className="section-heading"><div><span className="eyebrow">TRACKER</span><h2>Your applications</h2></div><span className="job-count">{tracker.length} total</span></div><div className="tracker-summary"><div><strong>{counts.applied}</strong><span>Applied</span></div><div><strong>{counts.interview}</strong><span>Interview</span></div><div><strong>{counts.followup}</strong><span>Follow-ups</span></div></div><div className="job-list">{tracker.map((item) => <article className="job-card tracker-card" key={item.id}><div className="job-card-top"><div><h3>{item.job_title}</h3><p>{item.company}</p></div><span className="status-pill">{item.status}</span></div><div className="job-meta"><span>{item.location || "Goa"}</span><span>·</span><span>{formatDate(item.last_action_at)}</span></div></article>)}{!tracker.length && <div className="empty-state">Applications you send will appear here.</div>}</div></section>}
    {tab === "Profile" && <section className="profile-section"><span className="eyebrow">PROFILE</span><h2>Your CV</h2><p className="profile-help">Your CV is the only candidate information JobApp needs. It is stored securely in Supabase and used by Gemini when preparing applications.</p><div className="cv-upload-card"><div><strong>{profile.cvName ? "CV uploaded" : "No CV uploaded"}</strong><p>{profile.cvName ? `${profile.cvName}${profile.cvUploadedAt ? ` · Last uploaded ${formatDate(profile.cvUploadedAt)}` : ""}` : "PDF only · maximum 10 MB"}</p></div><label className="upload-button">{profile.cvName ? "Upload New CV" : "Upload CV"}<input type="file" accept="application/pdf,.pdf" onChange={uploadCv} disabled={loading} /></label></div></section>}
    <nav className="bottom-nav" aria-label="Primary navigation">{(["Jobs", "Tracker", "Profile"] as const).map((item) => <button key={item} className={tab === item ? "nav-active" : ""} onClick={() => setTab(item)}>{item === "Jobs" ? "⌂" : item === "Tracker" ? "▣" : "♙"}<span>{item}</span></button>)}</nav>
    {selectedJob && selectedPerson && <div className="modal-backdrop" onClick={() => { if (!loading) { setSelectedJob(null); setSelectedPerson(null); setDraft(null); } }}><div className="modal" onClick={(e) => e.stopPropagation()}>{!draft ? <><span className="eyebrow">GENERATING</span><h2>Preparing email...</h2><p>{selectedPerson.name} · {selectedPerson.title || "Hiring contact"}</p><p>{selectedPerson.email}</p></> : <><span className="eyebrow">REVIEW BEFORE SENDING</span><h2>Personalized application</h2><p>To: <strong>{selectedPerson.name}</strong> · {selectedPerson.email}</p><div className="match-panel"><span className="match">{draft.fitScore}%</span><div><strong>Gemini fit score</strong>{draft.fitReasons.map((reason, index) => <p key={index}>• {reason}</p>)}</div></div><p className="attachment-note">CV attachment: <strong>{draft.cvName || profile.cvName}</strong></p><label>Subject<input value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} /></label><label>Message<textarea className="message-box" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} /></label><div className="modal-actions"><button className="secondary-button" onClick={() => { setSelectedJob(null); setSelectedPerson(null); setDraft(null); }}>Close</button><button className="primary-button" disabled={!gmail.connected || loading} onClick={sendEmail}>{!gmail.connected ? "Connect Gmail to Send" : loading ? "Sending..." : "Send Application"}</button></div>{!gmail.connected && <small className="disabled-note">Gmail must be connected within the 12-hour session before sending.</small>}</>}</div></div>}
  </main>;
}
