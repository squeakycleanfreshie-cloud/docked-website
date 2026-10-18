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
- Each submission needs: title, playable link, one Hackatime project, and every checklist item ticked (checked server-side).
- The Hackatime project must have time logged inside that jam's week, and can't be reused for another jam.
- Points = `POINTS_PER_HOUR` per hour on that project, counting only time inside the jam's week. Points never decrease. Accounts with trust_value 1 are rejected.
- `POST /api/sync` re-pulls hours for all your submissions, including closed weeks (still capped at the week's end).
- One Hackatime account can link to one user only.
- Checklist is based on the Horizons shipping guide (edit `CHECKLIST` in `server.js`).

## API
- GET `/api/status`, `/api/me`, `/api/jams`, `/api/store`, `/api/hackatime/projects`
- POST `/api/jams/:week/submit {title,url,project,checklist[]}`, `/api/sync`, `/api/store/redeem {itemId}`, `/api/hackatime/unlink`
- POST `/api/demo/log-hours {hours}` (DEMO_MODE only)

## Notes
- Storage is `db.json`. Swap for SQLite/Postgres before real use.
- Sessions use the in-memory store. Use a persistent store in production.
- Redemptions are only recorded. Fulfilment is manual (`db.json` -> `orders`).
