# JobApp

Mobile-first job discovery, personalized applications, Gmail sending, and application tracking.

## Production architecture

- **Next.js + TypeScript** — mobile-first application and server routes
- **Supabase** — candidate profile, private PDF CV storage, jobs, and application tracker
- **Apify `kindred_llama~job-scraper`** — one controlled daily collection from multiple job boards
- **Gemini** — CV-aware job-fit scoring and personalized application generation
- **Google OAuth + Gmail API** — 12-hour sending session with CV attachment

## Job discovery

The selected Apify Actor supports LinkedIn, Indeed, SimplyHired, Remotive, RemoteOK, Arbeitnow, and Jobicy. Its input supports keyword, location, result limit, posting age, job type, education, and skills filters. urlApify Job Scraperhttps://apify.com/kindred_llama/job-scraper

For the budget-conscious production setup:

- one Actor run is allowed per calendar day;
- `maxResults` defaults to 10 per selected source;
- jobs are normalized and deduplicated before storage;
- only Goa and Remote jobs are persisted;
- Remote is capped at 20 jobs/day;
- Goa is capped at 50 jobs/day;
- the database claim function prevents duplicate daily runs even if cron and the first user request arrive at the same time.

The app invokes the Actor through the Apify API and reads its default dataset output. urlApify API documentationhttps://docs.apify.com/api/v2/actors-runs-post

## Gemini

Gemini is called only when the user starts an application flow rather than for every scraped job. The server generates a concise, truthful personalized email and returns structured JSON. The candidate profile is the source of truth; the model is instructed not to invent qualifications, employers, achievements, dates, or skills.

## Gmail

- Google OAuth only; JobApp never handles the Gmail password.
- Sending requires an active 12-hour JobApp Gmail session.
- The server checks the session before every send.
- The PDF CV stored in Supabase is attached automatically by the Gmail send endpoint.

## Required Vercel environment variables

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
SESSION_SECRET
GMAIL_TOKEN_ENCRYPTION_KEY
GEMINI_API_KEY
APIFY_API_TOKEN
APIFY_ACTOR_ID
APIFY_KEYWORD
APIFY_INPUT_JSON
CRON_SECRET
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI
```

Never commit secret values to Git. `APIFY_API_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`, Gemini keys, Gmail client secrets, encryption keys, and `CRON_SECRET` must remain server-side.

## Daily cron

Vercel calls `/api/cron/jobs` at **03:30 UTC / 09:00 IST**. The endpoint requires `Authorization: Bearer <CRON_SECRET>` and the database claim function guarantees a single successful collection for that date.

## Local setup

1. Install dependencies.
2. Copy `.env.example` to `.env.local`.
3. Add production credentials.
4. Apply the Supabase migrations.
5. Run `npm run dev`.
