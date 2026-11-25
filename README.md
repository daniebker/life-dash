# Life Dash

A single-page dashboard for analysing your own life-tracking exports. Open `index.html` in a browser and drop your files on it. Nothing is uploaded anywhere: parsed files are kept in the browser's `localStorage`.

## Views

- **Summary tiles**: average sleep, work per working day, share of waking time that is tracked (not "Other"), habit targets met, share of positive check-ins.
- **Day ledger**: every day as a 24-hour strip coloured by activity group, with mood check-ins marked on it.
- **Where the time went**: total and per-day time for each activity.
- **Sleep per night**: duration, average bedtime and wake time, 8-hour reference line.
- **Habits**: heatmap of each habit against its daily target, with days met and current streak.
- **Oura**: sleep, readiness and activity scores, daily steps, and a nightly table (asleep vs in bed, efficiency, deep/REM, HRV, lowest heart rate, temperature deviation) next to the sleep you logged.
- **Mood check-ins** and **mood by activity**: each check-in is matched to the activity running at that moment.
- **Time log table**: the raw entries for the selected range.

Use the 7 / 14 / 30 days / All control to change the range.

## Supported files

Files are recognised by their content, not their name. You can add several of the same kind; entries are merged and de-duplicated.

| Kind | Format |
|---|---|
| Time log | CSV with header `start_ts,end_ts,duration_s,start,end,activity`. The `start`/`end` wall-clock columns are used; `*_ts` is the fallback. |
| Check-ins | CSV without header: `YYYY-MM-DD HH:MM,Core feeling,Feeling,Sub-feeling` (feeling-wheel style). |
| Habits | Binary `HBT1` file (see below). |
| Activities | Plain text, one activity name per line. |
| Oura | JSON written by `scripts/oura-sync.mjs`, or a raw Oura API v2 response (`{"data": [...]}`) from `daily_sleep`, `daily_readiness`, `daily_activity` or `sleep`. |

### `HBT1` habits format

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | magic `HBT1` |
| 4 | u16 | version |
| 6 | u16 | record size (404) |
| 8 | u32 | record count |
| 12 | record × count | records |

Each record is `name[24]` (NUL padded), `u16` daily target at 24, then one byte per day of the year, where day *d* (0 = 1 January) is at offset `26 + d`. Bytes 26–29 hold a 4-byte field (an id or checksum), so 1–4 January are not read. The file has no year field, so the year is taken from the file's modified date.

## Activity groups

Activities are coloured by group. Edit `GROUPS` at the top of the script in `index.html` to change the grouping:

- Sleep
- Work & study: Work, Study, Code
- Self-care: Exercise, Meditate, Eating, Read
- Logistics: Commute, Chores, Kids
- Social & leisure: Social, Leisure
- Other: anything else

## Oura

Oura's API can't be called from the browser page directly, so a small script fetches your data and writes `data/oura.json`, which the dashboard loads like any other file.

1. Create an access token in your Oura account (developer settings on cloud.ouraring.com).
2. Run the sync (Node 18+, no dependencies):

   ```bash
   OURA_TOKEN=your-token node scripts/oura-sync.mjs --days 60 --out data
   ```

   It fetches daily sleep, readiness and activity plus sleep sessions, merges them into `data/oura.json`, and adds `oura.json` to `data/manifest.json`. `OURA_TOKEN_FILE=/path/to/file` works instead of `OURA_TOKEN`. Naps and rests are ignored; for each day the main sleep is used.

When deployed with the workflow below, the sync runs daily on GitHub Actions and uploads the result to your server.

## Auto-loading files

When served over HTTP (for example `python3 -m http.server`), the page loads the files listed in `data/manifest.json` on first visit:

```json
["activities.txt", "log.csv", "checkins.csv", "habits.dat"]
```

Binary files can also be listed base64-encoded with a `.b64` suffix (e.g. `habits.dat.b64`).

`data/` is git-ignored so personal data stays out of the repository.

## Deploying to a server

`.github/workflows/deploy.yml` copies `index.html` and `scripts/` to a server over SSH with rsync on every push to `main` (or by running the workflow manually). The server's `data/` folder is never overwritten or deleted by a deploy, so your files there are safe. Serve the folder with any static web server.

The server needs `rsync` and an SSH user who can write to the deploy folder.

**Set up**, under the repository's Settings → Secrets and variables → Actions:

| Name | Kind | Value |
|---|---|---|
| `SSH_PRIVATE_KEY` | secret | Private key of the deploy user, with its public key in that user's `~/.ssh/authorized_keys` on the server |
| `SSH_KNOWN_HOSTS` | secret | Output of `ssh-keyscan -p 22 your.server` (host keys are always checked) |
| `SSH_HOST` | variable | Server hostname |
| `SSH_USER` | variable | Deploy user |
| `DEPLOY_PATH` | variable | Folder on the server, e.g. `/var/www/life-dash` |
| `SSH_PORT` | variable | Optional, default `22` |
| `OURA_TOKEN` | secret | Optional. Turns on the daily Oura sync |

The jobs use a `production` environment, so you can add required reviewers or keep the secrets there instead of at repository level.

**Oura sync job**: runs daily at 06:17 UTC and on manual runs. It downloads the server's current `data/oura.json` and `data/manifest.json`, fetches the last 14 days (configurable on a manual run), merges them, and uploads both files back. It is skipped when `OURA_TOKEN` is not set.

If you'd rather keep the token on your server, skip `OURA_TOKEN` and use cron there instead:

```cron
17 6 * * * cd /var/www/life-dash && OURA_TOKEN_FILE=/etc/life-dash/oura-token node scripts/oura-sync.mjs --days 14 --out data
```

Personal data is served as static files, so put the site behind authentication (for example HTTP basic auth in your web server) if the server is reachable from the internet.
