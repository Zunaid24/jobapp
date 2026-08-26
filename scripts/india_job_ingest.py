#!/usr/bin/env python3
"""Collect fresh Goa jobs from Naukri, LinkedIn and Indeed India.

This is the thin JobApp adapter around the India-first `india-jobspy` project.
It deliberately keeps the scraper outside the Next.js/Vercel runtime: the
GitHub Actions runner executes the Python scrapers, then posts normalized jobs
to JobApp for Supabase storage + Gemini ranking.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from datetime import datetime, timezone

import pandas as pd
import requests
from india_jobspy.scrape import scrape_jobs

QUERIES = [
    "HR Executive",
    "Human Resources",
    "HR Recruiter",
    "Talent Acquisition",
    "HR Coordinator",
]


def clean(value):
    if value is None:
        return None
    if isinstance(value, float) and pd.isna(value):
        return None
    return str(value).strip() or None


def normalize(row: dict) -> dict | None:
    title = clean(row.get("title"))
    company = clean(row.get("company"))
    location = clean(row.get("location")) or clean(row.get("city"))
    url = clean(row.get("job_url"))
    if not title or not company or not location or not url:
        return None

    # Keep Goa/Panaji/Panjim and the major Goa city spellings. Do not let a
    # remote India result slip into the Goa-only daily feed.
    if not any(x in location.lower() for x in ("goa", "panaji", "panjim", "margao", "mapusa", "vasco")):
        return None

    source = clean(row.get("site")) or "unknown"
    source_id = hashlib.sha256(url.lower().encode()).hexdigest()[:32]

    posted = clean(row.get("date_posted"))
    if posted:
        try:
            posted = pd.to_datetime(posted, utc=True).isoformat()
        except Exception:
            posted = None

    return {
        "id": source_id,
        "source_job_id": source_id,
        "source": source,
        "title": title,
        "company": company,
        "location": "Goa",
        "type": clean(row.get("job_type")) or "Full-time",
        "description": (clean(row.get("description")) or "")[:30000],
        "apply_url": url,
        "posted_at": posted,
        "salary_min": row.get("min_amount"),
        "salary_max": row.get("max_amount"),
        "currency": clean(row.get("currency")) or "INR",
        "experience": clean(row.get("experience")),
        "raw": row,
    }


def main() -> int:
    endpoint = os.environ["JOBAPP_INGEST_URL"].rstrip("/")
    secret = os.environ["CRON_SECRET"]
    hours_old = int(os.getenv("JOB_FRESHNESS_HOURS", "72"))
    results_per_query = int(os.getenv("RESULTS_PER_QUERY", "20"))

    collected: list[dict] = []
    failures: list[str] = []

    for query in QUERIES:
        try:
            frame = scrape_jobs(
                search_term=query,
                location="Goa",
                site_name=["naukri", "linkedin", "indeed"],
                results_wanted=results_per_query,
                hours_old=hours_old,
                linkedin_fetch_description=False,
                verbose=0,
            )
            for record in frame.to_dict(orient="records"):
                normalized = normalize(record)
                if normalized:
                    collected.append(normalized)
        except Exception as exc:
            failures.append(f"{query}: {exc}")

    # Cross-source URL dedupe before the API call. Keep the first source record.
    unique = {}
    for job in collected:
        unique.setdefault(job["id"], job)

    payload = {
        "source": "india-jobspy",
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "jobs": list(unique.values()),
        "failures": failures,
    }

    response = requests.post(
        f"{endpoint}/api/internal/jobs/import",
        headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json"},
        json=payload,
        timeout=120,
    )
    if response.status_code >= 300:
        print(response.text, file=sys.stderr)
        return 1

    print(json.dumps({"scraped": len(collected), "unique": len(unique), "failures": failures, "result": response.json()}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
