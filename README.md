# JobApp

Mobile-first job discovery, personalized applications, Gmail sending, and application tracking.

## Architecture

- **Next.js + TypeScript** — mobile-first app and server routes
- **Supabase** — candidate profile, private PDF CV storage, jobs, and application tracker
- **Apify** — daily job collection
- **Gemini** — CV-aware job-fit scoring and personalized application generation
- **Google OAuth + Gmail API** — 12-hour sending session with CV attachment

## Job discovery rules

- **Goa** — Goa jobs collected by Apify
- **Remote** — worldwide remote jobs, limited to 20 displayed results per day
- Apify collection is protected by a database run lock so the production app performs at most one collection per calendar day.
- Vercel cron triggers the daily collection at 03:30 UTC (09:00 IST).

## Gemini

Gemini receives the candidate's stored PDF CV plus the selected job and returns:

- fit score (0–100)
- up to three fit reasons
- personalized subject
- personalized email body

The application generation never asks the model to invent candidate facts.

## Gmail

- Google OAuth only; JobApp never handles the Gmail password.
- Sending requires an active 12-hour JobApp Gmail session.
- Server-side checks enforce the session before every send.
- The stored PDF CV is automatically attached to applications.

## Required environment variables

See `.env.example`. In production, keep all API tokens and encryption secrets server-side.

For Apify:

```text
APIFY_API_TOKEN=
APIFY_ACTOR_ID=
APIFY_INPUT_JSON={}
```

`APIFY_INPUT_JSON` should be the exact JSON input expected by the selected Actor/task and should be configured to collect the Goa and Remote job sources required by the product. The app normalizes common fields such as title, company, location, description, apply URL, contact email, and posted date.

For daily cron protection:

```text
CRON_SECRET=
```

## Database

Apply the Supabase migrations in `supabase/migrations` to the `jobapp` project. The `jobs` and `job_collection_runs` tables are server-only and use the Supabase service role on the backend.

## Local setup

1. Install dependencies.
2. Copy `.env.example` to `.env.local`.
3. Add the required credentials.
4. Apply the Supabase migrations.
5. Run `npm run dev`.
