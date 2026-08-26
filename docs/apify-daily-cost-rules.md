# Apify daily cost rules

- Actor 1 is `curious_coder/linkedin-jobs-scraper`.
- Do not send unsupported `excludeJobs` input to Actor 1.
- Search only Goa and the target HR role families.
- Prefer `past24Hours` for the daily run.
- Keep Actor 1 result limits small; 10 is the target, 50 is the absolute application-level ceiling.
- Permanently deduplicate against Supabase job history using stable job IDs where available and normalized title/company/location fingerprints.
- Gemini ranks only new normalized jobs and the application stores at most the top 10 qualifying jobs.
- Do not call Actor 2 until a user opens/pursues a qualifying job.
- Do not call Actor 3 until the user selects the people whose emails are needed.
- `APIFY_DAILY_MAX_CHARGE_USD` remains a server-side safety ceiling; an AI recommendation can never raise it.
