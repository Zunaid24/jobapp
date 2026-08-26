#!/usr/bin/env python3
"""Collect genuinely fresh Goa jobs from LinkedIn and Indeed India."""
from __future__ import annotations

import hashlib
import json
import os
import sys
from datetime import date, datetime, timezone

import pandas as pd
import requests
from india_jobspy.scrape import scrape_jobs

QUERIES = ["HR Executive", "Human Resources", "HR Recruiter", "Talent Acquisition", "HR Coordinator"]
SITES = ["linkedin", "indeed"]
ALLOWED_SOURCES = {"linkedin", "indeed"}
GOA_TERMS = ("goa", "panaji", "panjim", "margao", "mapusa", "vasco")


def clean(value):
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    if isinstance(value, (pd.Timestamp, datetime, date)):
        return value.isoformat()
    return str(value).strip() or None


def normalize(row: dict, max_age_hours: int) -> dict | None:
    title = clean(row.get("title")); company = clean(row.get("company")); location = clean(row.get("location")) or clean(row.get("city")); url = clean(row.get("job_url"))
    source = (clean(row.get("site")) or "").lower().strip()
    if source not in ALLOWED_SOURCES or not title or not company or not location or not url:
        return None
    if not any(x in location.lower() for x in GOA_TERMS):
        return None
    raw_posted = row.get("date_posted")
    if raw_posted is None or (isinstance(raw_posted, float) and pd.isna(raw_posted)):
        return None
    try:
        posted_dt = pd.to_datetime(raw_posted, utc=True)
        if pd.isna(posted_dt):
            return None
        age_hours = (pd.Timestamp.now(tz="UTC") - posted_dt).total_seconds() / 3600
        if age_hours < -1 or age_hours > max_age_hours:
            return None
        posted = posted_dt.isoformat()
    except Exception:
        return None
    source_id = hashlib.sha256(url.lower().encode()).hexdigest()[:32]
    return {
        "id": source_id, "source_job_id": source_id, "source": source,
        "title": title, "company": company, "location": "Goa",
        "type": clean(row.get("job_type")) or "Full-time",
        "description": (clean(row.get("description")) or "")[:30000],
        "apply_url": url, "posted_at": posted,
        "salary_min": clean(row.get("min_amount")), "salary_max": clean(row.get("max_amount")),
        "currency": clean(row.get("currency")) or "INR", "experience": clean(row.get("experience")),
    }


def main() -> int:
    endpoint = os.environ["JOBAPP_INGEST_URL"].rstrip("/")
    secret = os.environ["CRON_SECRET"]
    hours_old = int(os.getenv("JOB_FRESHNESS_HOURS", "72")); results_per_query = int(os.getenv("RESULTS_PER_QUERY", "20"))
    collected: list[dict] = []; failures: list[str] = []
    for query in QUERIES:
        try:
            frame = scrape_jobs(search_term=query, location="Goa", site_name=SITES, results_wanted=results_per_query, hours_old=hours_old, linkedin_fetch_description=False, verbose=0)
            for record in frame.to_dict(orient="records"):
                job = normalize(record, hours_old)
                if job: collected.append(job)
        except Exception as exc:
            failures.append(f"{query}: {exc}")
    unique = {}
    for job in collected: unique.setdefault(job["id"], job)
    payload = {"source": "india-jobspy", "collected_at": datetime.now(timezone.utc).isoformat(), "jobs": list(unique.values()), "failures": failures}
    response = requests.post(f"{endpoint}/api/internal/jobs/import", headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json"}, json=payload, timeout=120)
    if response.status_code >= 300:
        print(response.text, file=sys.stderr); return 1
    print(json.dumps({"scraped": len(collected), "unique": len(unique), "failures": failures, "result": response.json()}, indent=2)); return 0


if __name__ == "__main__":
    raise SystemExit(main())
