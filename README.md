# Docked

Node 18+ / Express. No CSS, minimal UI.

## Setup
1. `npm install`
2. `cp .env.example .env` and fill it in
3. GitHub OAuth app: https://github.com/settings/developers
   - callback: `BASE_URL/auth/github/callback`
4. Hackatime OAuth app: https://hackatime.hackclub.com (Settings -> OAuth apps)
   - callback: `BASE_URL/auth/hackatime/callback`
   - scopes: `profile read`
5. `npm start`

Set `DEMO_MODE=true` to fake hours without Hackatime.

## Flow
- `/` is the landing page (image + button), `/app.html` is the app.
- GitHub OAuth = login (session cookie).
- Hackatime OAuth = link. Calls `/api/v1/authenticated/me`, stores only the Hackatime user id (no token).
- Jam week N runs from `CHALLENGE_START + (N-1)*7d` to `+N*7d`. Submissions can only be created or edited during that week.
- Each submission needs: title, description (30-1000 chars), playable link, code link (GitHub/GitLab/Codeberg/Bitbucket/SourceHut), screenshot, one Hackatime project with at least `MIN_HOURS` (10) hours that week, and every checklist item ticked. All checked server-side.
- Screenshots are resized in the browser, validated (png/jpg/webp, magic bytes, under 3MB) and saved to `UPLOAD_DIR` (default `./uploads`). Free Render disks are wiped on redeploy, so mount a persistent disk or move to object storage.
- The Hackatime project must have time logged inside that jam's week, and can't be reused for another jam.
- Points = `POINTS_PER_HOUR` per hour on that project, counting only time inside the jam's week. Points never decrease. Accounts with trust_value 1 are rejected.
- `POST /api/sync` re-pulls hours for all your submissions, including closed weeks (still capped at the week's end).
- One Hackatime account can link to one user only.
- Checklist is based on the Horizons shipping guide (edit `CHECKLIST` in `server.js`).

## Out mode and freezes
- Weekly target is `MIN_HOURS` (10) of total Hackatime time across all projects. Tracking starts the week a user first links Hackatime.
- When a week closes under target you are **out** and owe `OUT_MULTIPLIER` (1.3) x the missed hours. Hours logged in later weeks pay that debt down (live, including the current week). At 0 you are back in.
- While out you cannot submit jams or redeem items. Freezes can still be bought.
- Streak freeze costs `POINTS_PER_HOUR` points (the price of an hour). Each one adds 1 hour to a closed week that falls short, applied automatically when the week settles. Freezes bought after a week closes only count for later weeks (closed weeks settle first).
- Switch 2 bar = total Hackatime hours since the start vs `GOAL_HOURS` (500).
- Weeks settle lazily when the user loads the app or buys a freeze.

## API
- GET `/api/status`, `/api/me`, `/api/jams`, `/api/store`, `/api/hackatime/projects`
- POST `/api/jams/:week/submit {title,url,project,checklist[]}`, `/api/sync`, `/api/store/redeem {itemId}`, `/api/hackatime/unlink`
- POST `/api/demo/log-hours {hours}` (DEMO_MODE only)

## Notes
- Storage is `db.json`. Swap for SQLite/Postgres before real use.
- Sessions use the in-memory store. Use a persistent store in production.
- Redemptions are only recorded. Fulfilment is manual (`db.json` -> `orders`).
