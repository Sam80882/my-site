# my-site

Streak: a personal streak tracker with a login, a daily check-in and a calendar with stats. It's hosted on Netlify.

- `frontend/` has the HTML, CSS and JavaScript that run in the browser.
- `netlify/functions/api.mjs` is the backend, a Netlify Function at `/api/*`. It handles login, saving days and locking past days. Data is stored in Netlify Blobs.

## Netlify settings

In **Site configuration → Environment variables**, add:

| Variable | Example | Notes |
| --- | --- | --- |
| `STREAK_USERNAME` | `sharath` | Login ID (required) |
| `STREAK_PASSWORD` | a strong password | Required |
| `STREAK_START_DATE` | `2026-10-24` | First day that can be tracked |
| `STREAK_TIMEZONE` | `Asia/Kolkata` | What "today" means; this is the default |
| `SESSION_SECRET` | any long random text | Optional; changing it logs everyone out |

Then trigger a new deploy. Build settings come from `netlify.toml`, so no build command is needed.

## Run locally (needs Node.js)

```powershell
npm install
npx netlify-cli dev
```

Put the same variables in a `.env` file first (git-ignored), for example `STREAK_USERNAME=sharath`.

## How it works

- **Today's update:** Yes marks the day green. No asks how many times, then adds that many X marks to the day.
- **Missed days:** click any day from the start date to today in the calendar to update it.
- **Saving vs locking:** a saved day can be edited until it's locked. A day can be locked from the calendar once it's over (for example, 24 Oct from 25 Oct onward). Locked days show a red dot and can't be changed.
- **Calendar colours:** green = streak kept, red = broke once, black = broke 2 or more times.
- **Stats:** success rate, current and highest streak, green and broken days, total X (negative points), average X per day and the last 30 days.
