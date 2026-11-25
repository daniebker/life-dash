# Life Dash

A single-page dashboard for analysing your own life-tracking exports. Open `index.html` in a browser and drop your files on it. Nothing is uploaded anywhere: parsed files are kept in the browser's `localStorage`.

## Views

- **Summary tiles**: average sleep, work per working day, share of waking time that is tracked (not "Other"), habit targets met, share of positive check-ins.
- **Day ledger**: every day as a 24-hour strip coloured by activity group, with mood check-ins marked on it.
- **Where the time went**: total and per-day time for each activity.
- **Sleep per night**: duration, average bedtime and wake time, 8-hour reference line.
- **Habits**: heatmap of each habit against its daily target, with days met and current streak.
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

## Auto-loading files

When served over HTTP (for example `python3 -m http.server`), the page loads the files listed in `data/manifest.json` on first visit:

```json
["activities.txt", "log.csv", "checkins.csv", "habits.dat"]
```

Binary files can also be listed base64-encoded with a `.b64` suffix (e.g. `habits.dat.b64`).

`data/` is git-ignored so personal data stays out of the repository.
