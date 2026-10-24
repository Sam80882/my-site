# my-site

Streak: a colourful personal streak tracker with a login, a daily check-in and a calendar with stats.

- `frontend/` has the HTML, CSS and JavaScript that run in the browser.
- `backend/server.ps1` serves the frontend and a small JSON API: login, sessions and saving each day's entry. It uses only Windows PowerShell, so there's nothing to install.

## Set your login (first time only)

```powershell
cd C:\Users\SharathM\Desktop\my-site
copy backend\config.example.json backend\config.json
notepad backend\config.json
```

Put your login ID and password in `config.json` and save it. `startDate` is the first day that can be tracked. This file is git-ignored, so it never gets committed.

## Run it

```powershell
powershell -ExecutionPolicy Bypass -File backend\server.ps1
```

Open http://localhost:8080/ and press Ctrl+C to stop. Use `-Port 3000` to pick another port.

Saved days are stored in `backend/data/entries.json`, which is also git-ignored.

## How it works

- **Today's update:** Yes marks the day green. No asks how many times, then adds that many X marks to the day.
- **Missed days:** click any day from `startDate` to today in the calendar to update it.
- **Saving vs locking:** a saved day can be edited until it's locked. A day can be locked from the calendar once it's over (for example, 24 Oct from 25 Oct onward). Locked days show a red dot and can't be changed.
- **Calendar colours:** green = streak kept, red = broke once, black = broke 2 or more times.
- **Stats:** success rate, current and highest streak, green and broken days, total X (negative points), average X per day and the last 30 days.
