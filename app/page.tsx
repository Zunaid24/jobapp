"use client";

import { useEffect, useMemo, useState } from "react";

type GmailStatus = { connected: boolean; email?: string | null; sessionExpiresAt?: number };
type Job = { id: string; title: string; company: string; location: string; type: string; match: number; description: string };
type TrackerItem = { id: string; job_id: string; job_title: string; company: string; location: string | null; status: string; subject: string | null; application_body: string | null; last_action_at: string };
type Profile = { name: string; experience: string; skills: string; resume: string };

const emptyProfile: Profile = { name: "", experience: "", skills: "", resume: "" };

function formatRemaining(expiresAt?: number) {
  if (!expiresAt) return "";
  const remaining = Math.max(0, expiresAt - Date.now());
  return `${Math.floor(remaining / 3600000)}h ${Math.floor((remaining % 3600000) / 60000)}m`;
}

export default function Home() {
  const [location, setLocation] = useState<"Goa" | "Remote">("Goa");
  const [tab, setTab] = useState<"Jobs" | "Tracker" | "Profile">("Jobs");
  const [gmail, setGmail] = useState<GmailStatus>({ connected: false });
  const [remaining, setRemaining] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [tracker, setTracker] = useState<TrackerItem[]>([]);
  const [profile, setProfile] = useState<Profile>(emptyProfile);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [draft, setDraft] = useState<{ subject: string; body: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");

  async function loadStatus() {
    const response = await fetch("/api/gmail/status", { cache: "no-store" });
    if (!response.ok) return;
    const status = (await response.json()) as GmailStatus;
    setGmail(status);
    setRemaining(formatRemaining(status.sessionExpiresAt));
  }

  async function loadJobs(nextLocation = location) {
    const response = await fetch(`/api/jobs?location=${nextLocation}`, { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    setJobs(data.jobs ?? []);
  }

  async function loadTracker() {
    const response = await fetch("/api/tracker", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    setTracker(data.items ?? []);
  }

  useEffect(() => {
    loadStatus();
    loadJobs();
    loadTracker();
    try {
      const saved = localStorage.getItem("jobapp_profile");
      if (saved) setProfile({ ...emptyProfile, ...JSON.parse(saved) });
    } catch { /* ignore malformed local profile */ }
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setRemaining(formatRemaining(gmail.sessionExpiresAt));
      if (gmail.sessionExpiresAt && gmail.sessionExpiresAt <= Date.now()) loadStatus();
    }, 30000);
    return () => window.clearInterval(interval);
  }, [gmail.sessionExpiresAt]);

  useEffect(() => { loadJobs(location); }, [location]);
  useEffect(() => { if (tab === "Tracker") loadTracker(); }, [tab]);

  const counts = useMemo(() => ({
    applied: tracker.filter((x) => x.status === "Applied").length,
    interview: tracker.filter((x) => x.status === "Interview").length,
    followup: tracker.filter((x) => x.status === "Follow-up").length,
  }), [tracker]);

  async function openApply(job: Job) {
    if (!gmail.connected) { setNotice("Connect Gmail before sending an application."); return; }
    setSelectedJob(job); setDraft(null); setLoading(true); setNotice("");
    try {
      const response = await fetch("/api/gemini/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate: profile, job }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to generate application");
      setDraft({ subject: data.subject, body: data.body });
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to generate application"); }
    finally { setLoading(false); }
  }

  async function saveProfile() {
    localStorage.setItem("jobapp_profile", JSON.stringify(profile));
    setNotice("Profile saved on this device.");
  }

  async function sendApplication(status: "Applied" | "Follow-up") {
    if (!selectedJob || !draft || !gmail.connected) return;
    setLoading(true); setNotice("");
    try {
      const to = prompt("Enter the recipient email address:", "");
      if (!to) { setLoading(false); return; }
      const send = await fetch("/api/gmail/send", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, subject: draft.subject, text: draft.body }),
      });
      const sendData = await send.json();
      if (!send.ok) throw new Error(sendData.error || "Unable to send email");
      await fetch("/api/tracker", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: selectedJob.id, jobTitle: selectedJob.title, company: selectedJob.company, location: selectedJob.location, status, subject: draft.subject, applicationBody: draft.body }),
      });
      await loadTracker();
      setSelectedJob(null); setDraft(null);
      setNotice(status === "Applied" ? "Application sent and added to Tracker." : "Follow-up sent and Tracker updated.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to send email"); }
    finally { setLoading(false); }
  }

  async function disconnect() {
    await fetch("/api/gmail/disconnect", { method: "POST" });
    setGmail({ connected: false }); setRemaining("");
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div><span className="eyebrow">JOBAPP</span><h1>Find your next role.</h1></div>
        <button className="icon-button" aria-label="Open menu">☰</button>
      </header>

      <section className={gmail.connected ? "gmail-card connected" : "gmail-card"}>
        <div><div className="status-line"><span className={gmail.connected ? "status-dot" : "status-dot offline"} /><strong>{gmail.connected ? "Gmail Connected" : "Gmail Not Connected"}</strong></div>
          {gmail.connected ? <p>{gmail.email ?? "Gmail account"} · Session expires in {remaining || "12h"}</p> : <p>Connect Gmail to enable all send actions.</p>}
        </div>
        {gmail.connected ? <button className="secondary-button" onClick={disconnect}>Disconnect</button> : <a className="primary-button" href="/api/gmail/connect">Connect Gmail</a>}
      </section>

      {notice && <div className="notice" role="status">{notice}</div>}

      {tab === "Jobs" && <>
        <div className="switcher" role="tablist" aria-label="Job location">
          {(["Goa", "Remote"] as const).map((item) => <button key={item} className={location === item ? "active" : ""} onClick={() => setLocation(item)}>{item}</button>)}
        </div>
        <section className="jobs-section">
          <div className="section-heading"><div><span className="eyebrow">DISCOVER</span><h2>{location} jobs</h2></div><span className="job-count">{location === "Remote" ? "20/day limit" : `${jobs.length} matching`}</span></div>
          <div className="job-list">
            {jobs.map((job) => <article className="job-card" key={job.id}>
              <div className="job-card-top"><div><h3>{job.title}</h3><p>{job.company}</p></div><span className="match">{job.match}%</span></div>
              <div className="job-meta"><span>{job.location}</span><span>·</span><span>{job.type}</span></div>
              <div className="actions"><button className="secondary-button" onClick={() => setSelectedJob(job)}>View</button><button className="primary-button" disabled={!gmail.connected} onClick={() => openApply(job)}>Apply</button></div>
              {!gmail.connected && <small className="disabled-note">Connect Gmail to send this application.</small>}
            </article>)}
            {!jobs.length && <div className="empty-state">No jobs found for this location.</div>}
          </div>
        </section>
      </>}

      {tab === "Tracker" && <section className="tracker-section">
        <div className="section-heading"><div><span className="eyebrow">TRACKER</span><h2>Your applications</h2></div><span className="job-count">{tracker.length} total</span></div>
        <div className="tracker-summary"><div><strong>{counts.applied}</strong><span>Applied</span></div><div><strong>{counts.interview}</strong><span>Interview</span></div><div><strong>{counts.followup}</strong><span>Follow-ups</span></div></div>
        <div className="job-list">{tracker.map((item) => <article className="job-card tracker-card" key={item.id}><div className="job-card-top"><div><h3>{item.job_title}</h3><p>{item.company}</p></div><span className="status-pill">{item.status}</span></div><div className="job-meta"><span>{item.location || "Remote"}</span><span>·</span><span>{new Date(item.last_action_at).toLocaleDateString()}</span></div>{item.status === "Applied" && gmail.connected && item.application_body && <button className="secondary-button full-button" onClick={() => { setSelectedJob({ id: item.job_id, title: item.job_title, company: item.company, location: item.location || "Remote", type: "", match: 0, description: "" }); setDraft({ subject: item.subject || `Follow-up: ${item.job_title}`, body: `Following up on my application for the ${item.job_title} position.\n\nI would be happy to provide any additional information.\n\nBest regards,\n${profile.name || "Candidate"}` }); }}>Prepare follow-up</button>}</article>)}{!tracker.length && <div className="empty-state">Applications you send will appear here.</div>}</div>
      </section>}

      {tab === "Profile" && <section className="profile-section"><span className="eyebrow">PROFILE</span><h2>Application profile</h2><p className="profile-help">Keep your details here so Gemini can personalize applications without inventing anything.</p>
        <label>Name<input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} placeholder="Your name" /></label>
        <label>Experience<textarea value={profile.experience} onChange={(e) => setProfile({ ...profile, experience: e.target.value })} placeholder="Years, roles, industries, achievements" /></label>
        <label>Skills<textarea value={profile.skills} onChange={(e) => setProfile({ ...profile, skills: e.target.value })} placeholder="HR, recruiting, operations..." /></label>
        <label>CV / Resume text<textarea value={profile.resume} onChange={(e) => setProfile({ ...profile, resume: e.target.value })} placeholder="Paste your CV text here" /></label>
        <button className="primary-button full-button" onClick={saveProfile}>Save Profile</button>
      </section>}

      <nav className="bottom-nav" aria-label="Primary navigation">{(["Jobs", "Tracker", "Profile"] as const).map((item) => <button key={item} className={tab === item ? "nav-active" : ""} onClick={() => setTab(item)}>{item === "Jobs" ? "⌂" : item === "Tracker" ? "▣" : "♙"}<span>{item}</span></button>)}</nav>

      {selectedJob && <div className="modal-backdrop" onClick={() => { if (!loading) { setSelectedJob(null); setDraft(null); } }}><div className="modal" onClick={(e) => e.stopPropagation()}>
        {!draft ? <><span className="eyebrow">JOB DETAILS</span><h2>{selectedJob.title}</h2><p className="modal-company">{selectedJob.company} · {selectedJob.location}</p><p className="modal-description">{selectedJob.description}</p><div className="modal-actions"><button className="secondary-button" onClick={() => setSelectedJob(null)}>Close</button><button className="primary-button" disabled={!gmail.connected || loading} onClick={() => openApply(selectedJob)}>{loading ? "Generating..." : "Generate Application"}</button></div>{!gmail.connected && <small className="disabled-note">Connect Gmail to generate and send an application.</small>}</> : <><span className="eyebrow">REVIEW BEFORE SENDING</span><h2>Personalized application</h2><label>Subject<input value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} /></label><label>Message<textarea className="message-box" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} /></label><div className="modal-actions"><button className="secondary-button" onClick={() => setDraft(null)}>Back</button><button className="primary-button" disabled={loading} onClick={() => sendApplication("Applied")}>{loading ? "Sending..." : "Send Application"}</button></div></>}
      </div></div>}
    </main>
  );
}
