"use client";

import { useEffect, useMemo, useState } from "react";

type GmailStatus = { connected: boolean; email?: string | null; sessionExpiresAt?: number };
type Job = { id: string; title: string; company: string; location: string; type: string; match: number; description: string; apply_url?: string | null; contact_email?: string | null };
type TrackerItem = { id: string; job_id: string; job_title: string; company: string; location: string | null; status: string; subject: string | null; application_body: string | null; last_action_at: string };
type Profile = { name: string; experience: string; skills: string; cvName: string | null; cvUploadedAt: string | null };
type Draft = { subject: string; body: string; fitScore: number; fitReasons: string[]; cvName?: string | null };

const emptyProfile: Profile = { name: "", experience: "", skills: "", cvName: null, cvUploadedAt: null };
function formatRemaining(expiresAt?: number) { if (!expiresAt) return ""; const remaining = Math.max(0, expiresAt - Date.now()); return `${Math.floor(remaining / 3600000)}h ${Math.floor((remaining % 3600000) / 60000)}m`; }

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
  async function loadProfile() { const response = await fetch("/api/profile", { cache: "no-store" }); if (!response.ok) return; const data = await response.json(); if (data.profile) setProfile({ ...emptyProfile, ...data.profile, cvName: data.profile.cv_name ?? null, cvUploadedAt: data.profile.cv_uploaded_at ?? null }); }

  useEffect(() => { loadStatus(); loadJobs(); loadTracker(); loadProfile(); }, []);
  useEffect(() => { const interval = window.setInterval(() => { setRemaining(formatRemaining(gmail.sessionExpiresAt)); if (gmail.sessionExpiresAt && gmail.sessionExpiresAt <= Date.now()) loadStatus(); }, 30000); return () => window.clearInterval(interval); }, [gmail.sessionExpiresAt]);
  useEffect(() => { loadJobs(location); }, [location]);
  useEffect(() => { if (tab === "Tracker") loadTracker(); if (tab === "Profile") loadProfile(); }, [tab]);
  useEffect(() => { const value = new URLSearchParams(window.location.search).get("gmail"); if (value === "connected") { setNotice("Gmail connected for the next 12 hours."); loadStatus(); window.history.replaceState({}, "", "/"); } else if (value && value !== "connected") { setNotice(`Gmail connection ${value.replaceAll("_", " ")}. Check the Google OAuth redirect URI and try again.`); window.history.replaceState({}, "", "/"); } }, []);

  const counts = useMemo(() => ({ applied: tracker.filter((x) => x.status === "Applied").length, interview: tracker.filter((x) => x.status === "Interview").length, followup: tracker.filter((x) => x.status === "Follow-up").length }), [tracker]);

  async function openApply(job: Job) {
    if (!gmail.connected) { setNotice("Connect Gmail before sending an application."); return; }
    if (!profile.cvName) { setNotice("Upload your PDF CV in Profile before applying."); setTab("Profile"); return; }
    setSelectedJob(job); setDraft(null); setLoading(true); setNotice("");
    try {
      const response = await fetch("/api/gemini/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ candidate: profile, job }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to generate application");
      setDraft({ subject: data.subject, body: data.body, fitScore: Number(data.fitScore ?? 0), fitReasons: data.fitReasons ?? [], cvName: data.cvName });
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to generate application"); } finally { setLoading(false); }
  }

  async function saveProfile() { setLoading(true); setNotice(""); try { const form = new FormData(); form.append("name", profile.name); form.append("experience", profile.experience); form.append("skills", profile.skills); const response = await fetch("/api/profile", { method: "POST", body: form }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Unable to save profile"); setProfile({ ...profile, cvName: data.profile?.cv_name ?? profile.cvName, cvUploadedAt: data.profile?.cv_uploaded_at ?? profile.cvUploadedAt }); setNotice("Profile saved securely in Supabase."); } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to save profile"); } finally { setLoading(false); } }

  async function uploadCv(event: React.ChangeEvent<HTMLInputElement>) { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; if (file.type !== "application/pdf" || !file.name.toLowerCase().endsWith(".pdf")) { setNotice("Please upload your CV as a PDF file."); return; } if (file.size > 10 * 1024 * 1024) { setNotice("CV must be 10 MB or smaller."); return; } setLoading(true); setNotice(""); try { const form = new FormData(); form.append("name", profile.name); form.append("experience", profile.experience); form.append("skills", profile.skills); form.append("cv", file); const response = await fetch("/api/profile", { method: "POST", body: form }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "Unable to upload CV"); setProfile({ ...profile, cvName: data.profile?.cv_name ?? file.name, cvUploadedAt: data.profile?.cv_uploaded_at ?? new Date().toISOString() }); setNotice("CV uploaded and saved securely in Supabase."); } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to upload CV"); } finally { setLoading(false); } }

  async function sendApplication(status: "Applied" | "Follow-up") {
    if (!selectedJob || !draft || !gmail.connected) return;
    setLoading(true); setNotice("");
    try {
      const to = selectedJob.contact_email || prompt("Enter the recipient email address:", "");
      if (!to) { setLoading(false); setNotice("No recipient email was provided."); return; }
      const send = await fetch("/api/gmail/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to, subject: draft.subject, text: draft.body }) });
      const sendData = await send.json(); if (!send.ok) throw new Error(sendData.error || "Unable to send email");
      await fetch("/api/tracker", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: selectedJob.id, jobTitle: selectedJob.title, company: selectedJob.company, location: selectedJob.location, status, subject: draft.subject, applicationBody: draft.body }) });
      await loadTracker(); setSelectedJob(null); setDraft(null); setNotice(status === "Applied" ? "Application sent and added to Tracker." : "Follow-up sent and Tracker updated.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to send email"); } finally { setLoading(false); }
  }

  async function disconnect() { await fetch("/api/gmail/disconnect", { method: "POST" }); setGmail({ connected: false }); setRemaining(""); }

  return <main className="app-shell">
    <header className="topbar"><div><span className="eyebrow">JOBAPP</span><h1>Find your next role.</h1></div><button className="icon-button" aria-label="Open menu">☰</button></header>
    <section className={gmail.connected ? "gmail-card connected" : "gmail-card"}><div><div className="status-line"><span className={gmail.connected ? "status-dot" : "status-dot offline"} /><strong>{gmail.connected ? "Gmail Connected" : "Gmail Not Connected"}</strong></div>{gmail.connected ? <p>{gmail.email ?? "Gmail account"} · Session expires in {remaining || "12h"}</p> : <p>Connect Gmail to enable all send actions.</p>}</div>{gmail.connected ? <button className="secondary-button" onClick={disconnect}>Disconnect</button> : <a className="primary-button" href="/api/gmail/connect">Connect Gmail</a>}</section>
    {notice && <div className="notice" role="status">{notice}</div>}
    {tab === "Jobs" && <><div className="switcher" role="tablist" aria-label="Job location">{(["Goa", "Remote"] as const).map((item) => <button key={item} className={location === item ? "active" : ""} onClick={() => setLocation(item)}>{item}</button>)}</div><section className="jobs-section"><div className="section-heading"><div><span className="eyebrow">DISCOVER</span><h2>{location} jobs</h2></div><span className="job-count">{location === "Remote" ? "20/day limit" : `${jobs.length} matching`}</span></div><div className="job-list">{jobs.map((job) => <article className="job-card" key={job.id}><div className="job-card-top"><div><h3>{job.title}</h3><p>{job.company}</p></div><span className="match">{job.match}%</span></div><div className="job-meta"><span>{job.location}</span><span>·</span><span>{job.type}</span></div><div className="actions"><button className="secondary-button" onClick={() => setSelectedJob(job)}>View</button><button className="primary-button" disabled={!gmail.connected || !profile.cvName} onClick={() => openApply(job)}>Apply</button></div>{!gmail.connected ? <small className="disabled-note">Connect Gmail to send this application.</small> : !profile.cvName && <small className="disabled-note">Upload a PDF CV in Profile to apply.</small>}</article>)}{!jobs.length && <div className="empty-state">No jobs found for this location yet. The daily job collection may still be running.</div>}</div></section></>}
    {tab === "Tracker" && <section className="tracker-section"><div className="section-heading"><div><span className="eyebrow">TRACKER</span><h2>Your applications</h2></div><span className="job-count">{tracker.length} total</span></div><div className="tracker-summary"><div><strong>{counts.applied}</strong><span>Applied</span></div><div><strong>{counts.interview}</strong><span>Interview</span></div><div><strong>{counts.followup}</strong><span>Follow-ups</span></div></div><div className="job-list">{tracker.map((item) => <article className="job-card tracker-card" key={item.id}><div className="job-card-top"><div><h3>{item.job_title}</h3><p>{item.company}</p></div><span className="status-pill">{item.status}</span></div><div className="job-meta"><span>{item.location || "Remote"}</span><span>·</span><span>{new Date(item.last_action_at).toLocaleDateString()}</span></div>{item.status === "Applied" && gmail.connected && item.application_body && <button className="secondary-button full-button" onClick={() => { setSelectedJob({ id: item.job_id, title: item.job_title, company: item.company, location: item.location || "Remote", type: "", match: 0, description: "" }); setDraft({ subject: item.subject || `Follow-up: ${item.job_title}`, body: `Following up on my application for the ${item.job_title} position.\n\nI would be happy to provide any additional information.\n\nBest regards,\n${profile.name || "Candidate"}`, fitScore: 0, fitReasons: [] }); }}>Prepare follow-up</button>}</article>)}{!tracker.length && <div className="empty-state">Applications you send will appear here.</div>}</div></section>}
    {tab === "Profile" && <section className="profile-section"><span className="eyebrow">PROFILE</span><h2>Application profile</h2><p className="profile-help">Your profile and CV are stored securely in Supabase. Upload a new PDF anytime to replace the current CV.</p><label>Name<input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} placeholder="Your name" /></label><label>Experience<textarea value={profile.experience} onChange={(e) => setProfile({ ...profile, experience: e.target.value })} placeholder="Years, roles, industries, achievements" /></label><label>Skills<textarea value={profile.skills} onChange={(e) => setProfile({ ...profile, skills: e.target.value })} placeholder="HR, recruiting, operations..." /></label><div className="cv-upload-card"><div><strong>{profile.cvName ? "CV uploaded" : "No CV uploaded"}</strong><p>{profile.cvName ? `${profile.cvName}${profile.cvUploadedAt ? ` · ${new Date(profile.cvUploadedAt).toLocaleDateString()}` : ""}` : "PDF only · maximum 10 MB"}</p></div><label className="upload-button">{profile.cvName ? "Upload New CV" : "Upload CV"}<input type="file" accept="application/pdf,.pdf" onChange={uploadCv} disabled={loading} /></label></div><button className="primary-button full-button" onClick={saveProfile} disabled={loading}>{loading ? "Saving..." : "Save Profile"}</button></section>}
    <nav className="bottom-nav" aria-label="Primary navigation">{(["Jobs", "Tracker", "Profile"] as const).map((item) => <button key={item} className={tab === item ? "nav-active" : ""} onClick={() => setTab(item)}>{item === "Jobs" ? "⌂" : item === "Tracker" ? "▣" : "♙"}<span>{item}</span></button>)}</nav>
    {selectedJob && <div className="modal-backdrop" onClick={() => { if (!loading) { setSelectedJob(null); setDraft(null); } }}><div className="modal" onClick={(e) => e.stopPropagation()}>{!draft ? <><span className="eyebrow">JOB DETAILS</span><h2>{selectedJob.title}</h2><p className="modal-company">{selectedJob.company} · {selectedJob.location}</p><p className="modal-description">{selectedJob.description}</p>{selectedJob.apply_url && <p className="attachment-note">Application link available from the job source.</p>}<div className="modal-actions"><button className="secondary-button" onClick={() => setSelectedJob(null)}>Close</button><button className="primary-button" disabled={!gmail.connected || !profile.cvName || loading} onClick={() => openApply(selectedJob)}>{loading ? "Generating..." : "Generate Application"}</button></div>{!gmail.connected ? <small className="disabled-note">Connect Gmail to generate and send an application.</small> : !profile.cvName && <small className="disabled-note">Upload a PDF CV in Profile to generate an application.</small>}</> : <><span className="eyebrow">REVIEW BEFORE SENDING</span><h2>Personalized application</h2><div className="match-panel"><span className="match">{draft.fitScore}%</span><div><strong>Gemini fit score</strong>{draft.fitReasons.map((reason, index) => <p key={index}>• {reason}</p>)}</div></div><label>Subject<input value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} /></label><label>Message<textarea className="message-box" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} /></label><div className="attachment-note">PDF attachment: {draft.cvName || profile.cvName || "your CV"}</div><div className="modal-actions"><button className="secondary-button" onClick={() => setDraft(null)}>Back</button><button className="primary-button" disabled={loading || !gmail.connected} onClick={() => sendApplication("Applied")}>{loading ? "Sending..." : "Send Application"}</button></div></>}</div></div>}
  </main>;
}
