from __future__ import annotations

import hashlib
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import quote_plus, urlparse

import requests
from bs4 import BeautifulSoup

BOARDS = {
    "linkedin": "linkedin.com/jobs/",
    "naukri": "naukri.com/job-listings",
    "foundit": "foundit.in/job",
    "indeed": "indeed.com/viewjob",
}
QUERIES = [
    'site:linkedin.com/jobs/ "HR" Goa',
    'site:naukri.com/job-listings "HR" Goa',
    'site:foundit.in/job "HR" Goa',
    'site:indeed.com/viewjob "HR" Goa',
]
DATE_RE = re.compile(r"\b(\d+)\s+(minute|minutes|hour|hours|day|days)\s+ago\b", re.I)


def _posted(text: str):
    m = DATE_RE.search(text or "")
    if not m:
        return None
    n, unit = int(m.group(1)), m.group(2).lower()
    delta = timedelta(minutes=n) if unit.startswith("minute") else timedelta(hours=n) if unit.startswith("hour") else timedelta(days=n)
    return (datetime.now(timezone.utc) - delta).isoformat()


def discover_google() -> list[dict]:
    out = []
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36"}
    for query in QUERIES:
        try:
            url = "https://www.google.com/search?q=" + quote_plus(query) + "&num=10"
            r = requests.get(url, headers=headers, timeout=20)
            r.raise_for_status()
            soup = BeautifulSoup(r.text, "html.parser")
            for result in soup.select("div.MjjYud"):
                a = result.select_one("a[href]")
                h3 = result.select_one("h3")
                if not a or not h3:
                    continue
                href = a.get("href", "")
                parsed = urlparse(href)
                target = href
                if parsed.netloc and parsed.netloc.endswith("google.com") and parsed.path == "/url":
                    from urllib.parse import parse_qs
                    target = parse_qs(parsed.query).get("q", [""])[0]
                domain = urlparse(target).netloc.lower()
                source = next((s for s, marker in BOARDS.items() if marker in domain + urlparse(target).path), None)
                if not source:
                    continue
                title = h3.get_text(" ", strip=True)
                snippet = result.get_text(" ", strip=True)
                posted = _posted(snippet)
                if not posted or not re.search(r"\b(goa|panaji|panjim|margao|mapusa|vasco)\b", snippet, re.I):
                    continue
                sid = hashlib.sha256(target.lower().encode()).hexdigest()[:32]
                out.append({"id": sid, "source_job_id": sid, "source": source, "title": title, "company": "", "location": "Goa", "description": snippet, "apply_url": target, "posted_at": posted})
        except Exception:
            continue
    return out
