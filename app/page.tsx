"use client";

import { useEffect, useMemo, useState } from "react";

type GmailStatus = {
  connected: boolean;
  email?: string | null;
  sessionExpiresAt?: number;
};

const jobs = [
  { title: "HR Manager", company: "Company Name", location: "Goa", type: "Full-time", match: 87 },
  { title: "People Operations Specialist", company: "Remote Company", location: "Remote", type: "Full-time", match: 84 },
  { title: "Talent Acquisition Executive", company: "Goa Startup", location: "Goa", type: "Full-time", match: 81 },
];

function formatRemaining(expiresAt?: number) {
  if (!expiresAt) return "";
  const remaining = Math.max(0, expiresAt - Date.now());
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m`;
}

export default function Home() {
  const [location, setLocation] = useState<"Goa" | "Remote">("Goa");
  const [gmail, setGmail] = useState<GmailStatus>({ connected: false });
  const [remaining, setRemaining] = useState("");

  async function loadStatus() {
    const response = await fetch("/api/gmail/status", { cache: "no-store" });
    if (!response.ok) return;
    const status = (await response.json()) as GmailStatus;
    setGmail(status);
    setRemaining(formatRemaining(status.sessionExpiresAt));
  }

  useEffect(() => {
    loadStatus();
    const interval = window.setInterval(() => {
      setRemaining(formatRemaining(gmail.sessionExpiresAt));
      if (gmail.sessionExpiresAt && gmail.sessionExpiresAt <= Date.now()) loadStatus();
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [gmail.sessionExpiresAt]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("gmail") === "connected") loadStatus();
  }, []);

  const visibleJobs = useMemo(
    () => jobs.filter((job) => (location === "Remote" ? job.location === "Remote" : job.location === "Goa")),
    [location],
  );

  async function disconnect() {
    await fetch("/api/gmail/disconnect", { method: "POST" });
    setGmail({ connected: false });
    setRemaining("");
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">JOBAPP</span>
          <h1>Find your next role.</h1>
        </div>
        <button className="icon-button" aria-label="Open menu">☰</button>
      </header>

      <section className={gmail.connected ? "gmail-card connected" : "gmail-card"}>
        <div>
          <div className="status-line">
            <span className={gmail.connected ? "status-dot" : "status-dot offline"} />
            <strong>{gmail.connected ? "Gmail Connected" : "Gmail Not Connected"}</strong>
          </div>
          {gmail.connected ? (
            <p>{gmail.email ?? "Gmail account"} · Session expires in {remaining || "12h"}</p>
          ) : (
            <p>Connect Gmail to enable all send actions.</p>
          )}
        </div>
        {gmail.connected ? (
          <button className="secondary-button" onClick={disconnect}>Disconnect</button>
        ) : (
          <a className="primary-button" href="/api/gmail/connect">Connect Gmail</a>
        )}
      </section>

      <div className="switcher" role="tablist" aria-label="Job location">
        {(["Goa", "Remote"] as const).map((item) => (
          <button key={item} className={location === item ? "active" : ""} onClick={() => setLocation(item)}>
            {item}
          </button>
        ))}
      </div>

      <section className="jobs-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">DISCOVER</span>
            <h2>{location} jobs</h2>
          </div>
          <span className="job-count">{location === "Remote" ? "20/day limit" : `${visibleJobs.length} matching`}</span>
        </div>

        <div className="job-list">
          {visibleJobs.map((job) => (
            <article className="job-card" key={job.title}>
              <div className="job-card-top">
                <div>
                  <h3>{job.title}</h3>
                  <p>{job.company}</p>
                </div>
                <span className="match">{job.match}%</span>
              </div>
              <div className="job-meta"><span>{job.location}</span><span>·</span><span>{job.type}</span></div>
              <div className="actions">
                <button className="secondary-button">View</button>
                <button className="primary-button" disabled={!gmail.connected} title={!gmail.connected ? "Connect Gmail first" : "Apply"}>Apply</button>
              </div>
              {!gmail.connected && <small className="disabled-note">Connect Gmail to send this application.</small>}
            </article>
          ))}
        </div>
      </section>

      <nav className="bottom-nav" aria-label="Primary navigation">
        <button className="nav-active">⌂<span>Jobs</span></button>
        <button>▣<span>Tracker</span></button>
        <button>♙<span>Profile</span></button>
      </nav>
    </main>
  );
}
