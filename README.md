# my-site

Streak: a personal streak tracker with a login, a daily check-in and a calendar with stats. It's hosted on Netlify.

- `frontend/` has the HTML, CSS and JavaScript that run in the browser.
- `netlify/functions/api.mjs` is the backend, a Netlify Function at `/api/*`. It handles login, saving days and locking past days. Data is stored in the Supabase table `daily_entries`, which only this function can reach (RLS on, no policies, service role key).

## Netlify settings

In **Site configuration → Environment variables**, add:

| Variable | Example | Notes |
| --- | --- | --- |
| `STREAK_USERS` | `sharath,anil,ravi` | Login IDs, comma-separated (falls back to `STREAK_USERNAME`) |
| `STREAK_PASSWORD` | a strong password | Shared by every account (required) |
| `SUPABASE_URL` | `https://xxxx.supabase.co` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | the service_role key | Secret, server-only; never put it in code |
| `SESSION_SECRET` | any long random text | Optional; changing it logs everyone out |

The login stays in Netlify, not in the code, because this repo is public. The start date (`START_DATE`) and timezone (`TIMEZONE`) are set at the top of `netlify/functions/api.mjs`.

Then trigger a new deploy. Build settings come from `netlify.toml`, so no build command is needed.

## Run locally (needs Node.js)

```powershell
npx netlify-cli dev
```

Put the same variables in a `.env` file first (git-ignored), for example `STREAK_USERNAME=sharath`.

## How it works

- **Today's update:** Yes marks the day green. No asks how many times, then adds that many X marks to the day.
- **Missed days:** click any day from the start date to today in the calendar to update it.
- **Saving vs locking:** a saved day can be edited until it's locked. A day can be locked from the calendar once it's over (for example, 24 Oct from 25 Oct onward). Locked days show a red dot and can't be changed.
- **Calendar colours:** green = streak kept, red = broke once, black = broke 2 or more times.
- **Stats:** success rate, current and highest streak, green and broken days, total X (negative points), average X per day and the last 30 days.

## Multiple accounts

Each login ID in `STREAK_USERS` gets its own days, streaks, locks and stats. All accounts share one password and one table: every row in `daily_entries` has a `username`, and the backend filters every read and write by the logged-in user. The stats page also has a leaderboard that compares everyone's totals (never anyone's individual days).

Database setup for multiple accounts (run once in the Supabase SQL editor):

```sql
alter table daily_entries add column if not exists username text;
update daily_entries set username = 'sharath' where username is null;
alter table daily_entries alter column username set not null;
alter table daily_entries drop constraint if exists daily_entries_entry_date_key;
alter table daily_entries add constraint daily_entries_user_day_key unique (username, entry_date);
```
