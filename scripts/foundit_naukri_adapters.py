from __future__ import annotations

import hashlib
import re
from datetime import datetime, timedelta, timezone
from typing import Any

import requests
from bs4 import BeautifulSoup

QUERIES = ["hr", "human resources", "hr executive", "hr recruiter", "talent acquisition"]
GOA = re.compile(r"\b(goa|panaji|panjim|margao|mapusa|vasco(?: da gama)?)\b", re.I)
DATE_RE = re.compile(r"(?:posted\s*)?(\d+)\s*(day|days|hour|hours)\s*ago", re.I)

def _date_from_text(text: str):
    m = DATE_RE.search(text or "")
    if not m: return None
    n, unit = int(m.group(1)), m.group(2).lower()
    delta = timedelta(days=n) if unit.startswith("day") else timedelta(hours=n)
    return (datetime.now(timezone.utc) - delta).isoformat()

def _job(source: str, title: str, company: str, location: str, url: str, description: str, posted: str | None):
    if not all([title, company, location, url, posted]) or not GOA.search(location): return None
    sid = hashlib.sha256(url.lower().encode()).hexdigest()[:32]
    return {"id": sid, "source_job_id": sid, "source": source, "title": title.strip(), "company": company.strip(), "location": "Goa", "type": "Full-time", "description": description[:30000], "apply_url": url, "posted_at": posted}

def scrape_foundit() -> list[dict]:
    out=[]; headers={"User-Agent":"Mozilla/5.0"}
    for q in QUERIES:
        slug = q.replace(" ", "-")
        url=f"https://www.foundit.in/search/{slug}-jobs-in-goa"
        try:
            r=requests.get(url,headers=headers,timeout=30); r.raise_for_status()
            soup=BeautifulSoup(r.text,"html.parser")
            for a in soup.select('a[href*="/job/"]'):
                title=a.get_text(" ",strip=True)
                if not title or len(title)>180: continue
                card=a
                for _ in range(5):
                    if card.parent: card=card.parent
                text=card.get_text(" ",strip=True)
                links=[x.get("href") for x in card.select('a[href*="/job/"]')]
                href=links[0] if links else a.get("href")
                if href and href.startswith("/"): href="https://www.foundit.in"+href
                company=""
                candidates=card.select('[class*="company"], [class*="Company"], a[href*="/company/"]')
                if candidates: company=candidates[0].get_text(" ",strip=True)
                posted=_date_from_text(text)
                job=_job("foundit",title,company,"Goa",href or "",text,posted)
                if job: out.append(job)
        except Exception: continue
    return out

def scrape_naukri() -> list[dict]:
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        return []
    out=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        page=browser.new_page()
        for q in QUERIES:
            slug=q.replace(" ","-")
            url=f"https://www.naukri.com/{slug}-jobs-in-goa"
            try:
                page.goto(url,wait_until="domcontentloaded",timeout=60000)
                for card in page.query_selector_all("article.jobTuple")[:30]:
                    title=card.query_selector("a.title").inner_text().strip() if card.query_selector("a.title") else ""
                    company=card.query_selector("a.subTitle").inner_text().strip() if card.query_selector("a.subTitle") else ""
                    loc=card.query_selector("li.location").inner_text().strip() if card.query_selector("li.location") else ""
                    link=card.query_selector("a.title").get_attribute("href") if card.query_selector("a.title") else ""
                    text=card.inner_text()
                    posted=_date_from_text(text)
                    job=_job("naukri",title,company,loc,link or "",text,posted)
                    if job: out.append(job)
            except Exception: continue
        browser.close()
    return out
