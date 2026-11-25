# Life Dash

A dashboard for analysing your own life-tracking exports. It runs two ways:

- **With the server** (`npm start`): sign in, upload files into a SQLite database where duplicate records are skipped, and connect Oura so your ring data syncs in the background.
- **On its own**: open `index.html` from any static host or from disk and drop files on it. Files stay in that browser's `localStorage`.

The page detects which mode it's in by checking for the server's `/api/me`.

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

## Static mode: auto-loading files

When served over HTTP (for example `python3 -m http.server`), the page loads the files listed in `data/manifest.json` on first visit:

```json
["activities.txt", "log.csv", "checkins.csv", "habits.dat"]
```

Binary files can also be listed base64-encoded with a `.b64` suffix (e.g. `habits.dat.b64`).

`data/` is git-ignored so personal data stays out of the repository.

`scripts/oura-sync.mjs` fetches Oura data into `data/oura.json` for static mode (`OURA_TOKEN=... node scripts/oura-sync.mjs --days 60`). The server doesn't need it.


## Server

Requires Node.js 22.13 or newer. It has no npm dependencies; SQLite comes from Node's built-in `node:sqlite`.

```bash
cp .env.example .env        # then set SECRET_KEY (openssl rand -hex 32) and the Oura values
npm run user -- add yourname
npm start
```

Open `PUBLIC_URL` (default http://localhost:8080) and sign in. Other user commands: `npm run user -- passwd yourname`, `npm run user -- list`, `npm run user -- remove yourname`.

### Uploads and de-duplication

Every upload is stored in the `uploads` table with its original bytes, and its records go into one table per kind. Duplicates are caught at two levels:

1. **Same file again**: recognised by its SHA-256 hash and nothing is stored. The page says when it was first uploaded.
2. **Overlapping exports**: each record has a natural key, so a record that already exists is never inserted twice. If the rest of it changed, it is updated in place.

| Records | Key | Updated when |
|---|---|---|
| Time log | start time + activity | end time changes (e.g. an entry that was still running) |
| Check-ins | time + all three feelings | never (any change is a different check-in) |
| Activities | name | never |
| Habit days | habit + date | the day's value changes |
| Oura | collection + Oura record id | the record's content changes |

Each upload reports how many records were new, updated and already stored. Uploaded Oura JSON and synced Oura data share one table, so they merge.

### Oura

1. Create an API application in the Oura developer portal. Set its redirect URI to `PUBLIC_URL/api/oura/callback`, e.g. `https://dash.example.com/api/oura/callback`.
2. Put its client ID and secret in `OURA_CLIENT_ID` and `OURA_CLIENT_SECRET` and restart.
3. On the dashboard, select **Connect Oura** in the Oura panel and approve access.

After connecting, the server fetches the last 90 days (`OURA_BACKFILL_DAYS`) in the background, then syncs every 60 minutes (`SYNC_INTERVAL_MINUTES`). Each sync refetches from 3 days before the last one, so late-arriving scores are picked up. **Sync now** runs one immediately. Access tokens are refreshed automatically. If Oura revokes access, the panel asks you to reconnect.

Tokens are encrypted in the database with a key derived from `SECRET_KEY`, so keep that value stable and secret. **Disconnect** deletes the tokens but keeps data already synced. To also revoke the app's access, remove it in your Oura account settings.

### Security

- Passwords are hashed with scrypt. Sessions are random tokens stored as SHA-256 hashes, in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` when `PUBLIC_URL` is https).
- State-changing API calls require an `X-Life-Dash` header, which cross-site forms can't send.
- After 5 failed sign-ins from one IP, sign-in is blocked for 15 minutes. Set `TRUST_PROXY=true` behind a reverse proxy so the real client IP is used.
- Only `index.html` and `parsers.js` are served as files. Everything else is behind the API.
- Run it behind HTTPS. Example nginx site:

```nginx
server {
    listen 443 ssl;
    server_name dash.example.com;
    # ssl_certificate ... (e.g. from certbot)
    client_max_body_size 25m;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Tests

```bash
npm test
```

This starts the server against a mock Oura service and covers sign-in, the CSRF guard, upload de-duplication for every file kind, the OAuth flow, background backfill, pagination, token refresh and revoked access.

## Deploying to a server

`.github/workflows/deploy.yml` runs the tests, then copies the app to your server over SSH with rsync on every push to `main` (or when run manually). It then runs `RESTART_COMMAND` if you set one. The server's `.env`, `var/` and `data/` are never overwritten or deleted.

**One-time server setup** (example for a Debian/Ubuntu host with Node 22):

```bash
sudo useradd --system --home /srv/life-dash lifedash
sudo mkdir -p /srv/life-dash && sudo chown deploy:lifedash /srv/life-dash
sudo cp .env.example /etc/life-dash.env && sudo chmod 640 /etc/life-dash.env && sudo chown root:lifedash /etc/life-dash.env
# edit /etc/life-dash.env: SECRET_KEY, PUBLIC_URL, DB_PATH=/var/lib/life-dash/life-dash.db, TRUST_PROXY=true, Oura values
```

After the first deploy, install the service and create your account:

```bash
sudo cp /srv/life-dash/deploy/life-dash.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now life-dash
```

```bash
sudo -u lifedash node --env-file=/etc/life-dash.env /srv/life-dash/server/cli.mjs add yourname
```

To let the deploy user restart the service, add a sudoers rule with `sudo visudo -f /etc/sudoers.d/life-dash`:

```
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart life-dash
```

**GitHub settings** (Settings → Secrets and variables → Actions):

| Name | Kind | Value |
|---|---|---|
| `SSH_PRIVATE_KEY` | secret | Private key of the deploy user, with its public key in that user's `~/.ssh/authorized_keys` |
| `SSH_KNOWN_HOSTS` | secret | Output of `ssh-keyscan -p 22 your.server` (host keys are always checked) |
| `SSH_HOST` | variable | Server hostname |
| `SSH_USER` | variable | Deploy user |
| `DEPLOY_PATH` | variable | e.g. `/srv/life-dash` |
| `SSH_PORT` | variable | Optional, default `22` |
| `RESTART_COMMAND` | variable | Optional, e.g. `sudo systemctl restart life-dash` |

The deploy job uses a `production` environment, so you can add required reviewers or keep the secrets there.
