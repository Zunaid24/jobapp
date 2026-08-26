# JobApp

Mobile-first job discovery, personalized applications, Gmail sending, and application tracking.

## Architecture

- Next.js + TypeScript
- Supabase
- Apify
- Gemini API
- Gmail OAuth

## Product rules

- Goa and Remote job discovery
- Remote limited to 20 displayed results per day
- One protected Apify collection per calendar day
- Gemini CV-aware fit scoring and personalized application emails
- PDF CV stored privately in Supabase and attached automatically to sent applications
- Gmail sending available only during the active 12-hour Gmail session
- Application tracker for Applied, Follow-up, Interview, Rejected, and Offer states

## Environment

See `.env.example` for the required production variables, including `APIFY_API_TOKEN`, `APIFY_ACTOR_ID`, `APIFY_INPUT_JSON`, `CRON_SECRET`, and `GEMINI_API_KEY`.
