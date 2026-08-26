#!/usr/bin/env python3
"""Stable India job discovery: LinkedIn/Indeed + Foundit + Naukri.

All sources must provide a real posting date. Every record is normalized and
sent through the same production 7-day/Goa/HR relevance gate.
"""
from __future__ import annotations
import hashlib, json, os, sys
from datetime import date, datetime, timezone
import pandas as pd
import requests
from jobspy import scrape_jobs
from foundit_naukri_adapters import scrape_foundit, scrape_naukri

QUERIES = ["HR Executive", "Human Resources", "HR Recruiter", "Talent Acquisition", "HR Coordinator"]
SITES = ["linkedin", "indeed"]
ALLOWED_SOURCES = {"linkedin", "indeed", "foundit", "naukri"}
GOA_TERMS = ("goa", "panaji", "panjim", "margao", "mapusa", "vasco")

def clean(value):
    if value is None or (isinstance(value, float) and pd.isna(value)): return None
    if isinstance(value, (pd.Timestamp, datetime, date)): return value.isoformat()
    return str(value).strip() or None

def normalize(row: dict, max_age_hours: int) -> dict | None:
    title=clean(row.get("title")); company=clean(row.get("company")); location=clean(row.get("location")) or clean(row.get("city")); url=clean(row.get("job_url", row.get("apply_url", row.get("url"))))
    source=(clean(row.get("site", row.get("source"))) or "").lower().strip()
    if source not in ALLOWED_SOURCES or not title or not company or not location or not url or not any(t in location.lower() for t in GOA_TERMS): return None
    raw_posted=row.get("date_posted", row.get("posted_at"))
    if not raw_posted: return None
    try:
        posted_dt=pd.to_datetime(raw_posted,utc=True)
        if pd.isna(posted_dt): return None
        age=(pd.Timestamp.now(tz="UTC")-posted_dt).total_seconds()/3600
        if age < -1 or age > max_age_hours: return None
    except Exception: return None
    sid=hashlib.sha256(url.lower().encode()).hexdigest()[:32]
    return {"id":sid,"source_job_id":sid,"source":source,"title":title,"company":company,"location":"Goa","type":clean(row.get("job_type",row.get("type"))) or "Full-time","description":(clean(row.get("description")) or "")[:30000],"apply_url":url,"posted_at":posted_dt.isoformat()}

def main() -> int:
    endpoint=os.environ["JOBAPP_INGEST_URL"].rstrip("/"); secret=os.environ["CRON_SECRET"]
    hours_old=int(os.getenv("JOB_FRESHNESS_HOURS","168")); results_per_query=int(os.getenv("RESULTS_PER_QUERY","20"))
    collected=[]; failures=[]
    try:
        for query in QUERIES:
            frame=scrape_jobs(site_name=SITES,search_term=query,location="Goa, India",distance=50,results_wanted=results_per_query,hours_old=hours_old,country_indeed="India",linkedin_fetch_description=False,verbose=1)
            for record in frame.to_dict(orient="records"):
                job=normalize(record,hours_old)
                if job: collected.append(job)
    except Exception as exc: failures.append(f"jobspy: {type(exc).__name__}: {exc}")
    for name, fn in (("foundit",scrape_foundit),("naukri",scrape_naukri)):
        try: collected.extend([j for j in fn() if j and normalize(j,hours_old)])
        except Exception as exc: failures.append(f"{name}: {type(exc).__name__}: {exc}")
    unique={}
    for job in collected: unique.setdefault(job["id"],job)
    jobs=list(unique.values())[:50]
    payload={"source":"india-multi-source","collected_at":datetime.now(timezone.utc).isoformat(),"jobs":jobs,"failures":failures}
    response=requests.post(f"{endpoint}/api/internal/jobs/import",headers={"Authorization":f"Bearer {secret}","Content-Type":"application/json"},json=payload,timeout=120)
    if response.status_code>=300: print(response.text,file=sys.stderr); return 1
    print(json.dumps({"discovered":len(jobs),"unique":len(unique),"failures":failures,"result":response.json()},indent=2)); return 0
if __name__=="__main__": raise SystemExit(main())
