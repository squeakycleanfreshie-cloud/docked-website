const express = require("express");
const session = require("express-session");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ---------- load .env (no dotenv dep) ----------
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch {}

const {
  PORT = 3000,
  BASE_URL = "http://localhost:3000",
  SESSION_SECRET = "dev-secret",
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  HCA_CLIENT_ID,
  HCA_CLIENT_SECRET,
  HCA_HOST = "https://auth.hackclub.com",
  HACKATIME_CLIENT_ID,
  HACKATIME_CLIENT_SECRET,
  CHALLENGE_START = "2026-10-26T00:00:00+11:00", // include a UTC offset
  POINTS_PER_HOUR = 10,
  DEMO_MODE = "false",
  MIN_HOURS = 10,
  UPLOAD_DIR = path.join(__dirname, "uploads"),
} = process.env;
const MINH = Number(MIN_HOURS);
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const PPH = Number(POINTS_PER_HOUR);
const HACKATIME = "https://hackatime.hackclub.com";
const WEEK_MS = 7 * 24 * 3600 * 1000;
const START = new Date(CHALLENGE_START);
if (isNaN(START)) throw new Error("CHALLENGE_START is not a valid date");

// ---------- static data ----------
const JAMS = [
  "One Button", "Tiny World", "Night Shift", "Out of Order", "Reverse",
  "Only One Life", "No Words", "Gravity", "Chain Reaction", "Your Masterpiece",
].map((theme, i) => ({ week: i + 1, theme }));

const STORE = [
  { id: "keycaps", name: "Custom keycap set", cost: 150 },
  { id: "mousepad", name: "Desk mat", cost: 200 },
  { id: "cable", name: "Braided USB-C cable", cost: 80 },
  { id: "lamp", name: "Desk lamp", cost: 250 },
  { id: "headphones", name: "Headphones", cost: 500 },
  { id: "keyboard", name: "Mechanical keyboard", cost: 800 },
];

// Based on the Horizons shipping guide
const CHECKLIST = [
  { key: "repo", text: "Code is in a public repo (GitHub, GitLab or similar)" },
  { key: "playable", text: "Game is playable at a public link (itch.io, GitHub Pages, Vercel, Netlify, Nest or a GitHub Release). Not localhost, a tunnel or Google Drive" },
  { key: "incognito", text: "I opened the link in an incognito window and it works without signing in" },
  { key: "readme", text: "README has a description, screenshots, tech stack and how to play" },
  { key: "ownwords", text: "README is written in my own words, not AI-generated" },
  { key: "commits", text: "Commits were made throughout the week, not in one big dump" },
  { key: "ai", text: "AI wrote less than 30% of the project" },
  { key: "new", text: "Made this week for this theme and not shipped to another Hack Club program" },
  { key: "hours", text: `I tracked at least ${MINH} hours on the Hackatime project selected below` },
  { key: "unique", text: "This Hackatime project is not reused from another jam" },
];

// ---------- time helpers ----------
const weekStart = (w) => new Date(START.getTime() + (w - 1) * WEEK_MS);
const weekEnd = (w) => new Date(START.getTime() + w * WEEK_MS);
function currentWeek(now = new Date()) {
  if (now < START) return 0;
  const w = Math.floor((now - START) / WEEK_MS) + 1;
  return w > JAMS.length ? JAMS.length + 1 : w; // length+1 = challenge over
}
const jamState = (w, now = new Date()) =>
  now < weekStart(w) ? "upcoming" : now >= weekEnd(w) ? "closed" : "open";

// ---------- tiny JSON "db" ----------
const DB_FILE = path.join(__dirname, "db.json");
let db = { users: {}, submissions: [], orders: [] };
try { db = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch {}
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

const earned = (u) => db.submissions.filter((s) => s.userId === u.id).reduce((n, s) => n + (s.points || 0), 0);
const hoursOf = (u) => db.submissions.filter((s) => s.userId === u.id).reduce((n, s) => n + (s.seconds || 0), 0) / 3600;
const balance = (u) => earned(u) + (u.demoPoints || 0) - (u.spentPoints || 0);

// ---------- app ----------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "4mb" }));
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: BASE_URL.startsWith("https") } }));

const me = (req) => db.users[req.session.uid];
const displayName = (u) => (u && (u.githubLogin || u.hcaName)) || "user";
const newUser = (f) => { const u = { id: crypto.randomUUID(), githubId: null, hcaId: null, hackatimeId: null, spentPoints: 0, demoPoints: 0, ...f }; db.users[u.id] = u; return u; };
const needLogin = (req, res, next) => (me(req) ? next() : res.status(401).json({ error: "log in with GitHub first" }));

const form = (o) => new URLSearchParams(o).toString();
async function postForm(url, body) {
  const r = await fetch(url, { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form(body) });
  return r.json();
}

// ---------- GitHub login ----------
app.get("/auth/github", (req, res) => {
  const state = (req.session.ghState = crypto.randomBytes(16).toString("hex"));
  res.redirect("https://github.com/login/oauth/authorize?" + form({
    client_id: GITHUB_CLIENT_ID, redirect_uri: `${BASE_URL}/auth/github/callback`,
    scope: "read:user", state }));
});

app.get("/auth/github/callback", async (req, res) => {
  try {
    if (!req.query.state || req.query.state !== req.session.ghState) return res.status(400).send("bad state");
    delete req.session.ghState;
    const t = await postForm("https://github.com/login/oauth/access_token", {
      client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET,
      code: req.query.code, redirect_uri: `${BASE_URL}/auth/github/callback` });
    if (!t.access_token) return res.status(400).send("github token failed");
    const gh = await (await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${t.access_token}`, "User-Agent": "docked" } })).json();
    const existing = Object.values(db.users).find((u) => u.githubId === gh.id);
    let user;
    if (me(req)) { // already logged in: link GitHub to this account
      if (existing && existing.id !== me(req).id) return res.status(409).send("that GitHub account is already linked to another user");
      user = me(req); user.githubId = gh.id;
    } else user = existing || newUser({ githubId: gh.id });
    user.githubLogin = gh.login;
    save();
    req.session.uid = user.id;
    res.redirect("/app.html");
  } catch (e) { console.error(e); res.status(500).send("github login error"); }
});

// ---------- Hack Club Auth login ----------
app.get("/auth/hackclub", (req, res) => {
  const state = (req.session.hcaState = crypto.randomBytes(16).toString("hex"));
  res.redirect(`${HCA_HOST}/oauth/authorize?` + form({
    client_id: HCA_CLIENT_ID, redirect_uri: `${BASE_URL}/auth/hackclub/callback`,
    response_type: "code", scope: "openid profile", state }));
});

app.get("/auth/hackclub/callback", async (req, res) => {
  try {
    if (!req.query.state || req.query.state !== req.session.hcaState) return res.status(400).send("bad state");
    delete req.session.hcaState;
    const t = await postForm(`${HCA_HOST}/oauth/token`, {
      client_id: HCA_CLIENT_ID, client_secret: HCA_CLIENT_SECRET, code: req.query.code,
      grant_type: "authorization_code", redirect_uri: `${BASE_URL}/auth/hackclub/callback` });
    if (!t.access_token) return res.status(400).send("hack club auth token failed");
    const r = await fetch(`${HCA_HOST}/oauth/userinfo`, { headers: { Authorization: `Bearer ${t.access_token}` } });
    if (!r.ok) return res.status(400).send("hack club auth userinfo failed");
    const info = await r.json();
    const hid = String(info.sub || info.id || "");
    if (!hid) return res.status(400).send("no hack club id");
    // public display name: first name + last initial
    const first = String(info.given_name || (info.name || "").split(" ")[0] || "").trim();
    const last = String(info.family_name || (info.name || "").split(" ").slice(1).join(" ") || "").trim();
    const name = (first + (last ? " " + last[0] + "." : "")).trim() || "Hack Clubber";
    const existing = Object.values(db.users).find((u) => u.hcaId === hid);
    let user;
    if (me(req)) { // already logged in: link Hack Club to this account
      if (existing && existing.id !== me(req).id) return res.status(409).send("that Hack Club account is already linked to another user");
      user = me(req); user.hcaId = hid;
    } else user = existing || newUser({ hcaId: hid });
    user.hcaName = name;
    save();
    req.session.uid = user.id;
    res.redirect("/app.html");
  } catch (e) { console.error(e); res.status(500).send("hack club login error"); }
});

// ---------- Hackatime link ----------
app.get("/auth/hackatime", needLogin, (req, res) => {
  const state = (req.session.htState = crypto.randomBytes(16).toString("hex"));
  res.redirect(`${HACKATIME}/oauth/authorize?` + form({
    client_id: HACKATIME_CLIENT_ID, redirect_uri: `${BASE_URL}/auth/hackatime/callback`,
    response_type: "code", scope: "profile read", state }));
});

app.get("/auth/hackatime/callback", needLogin, async (req, res) => {
  try {
    if (!req.query.state || req.query.state !== req.session.htState) return res.status(400).send("bad state");
    delete req.session.htState;
    const t = await postForm(`${HACKATIME}/oauth/token`, {
      client_id: HACKATIME_CLIENT_ID, client_secret: HACKATIME_CLIENT_SECRET,
      code: req.query.code, grant_type: "authorization_code",
      redirect_uri: `${BASE_URL}/auth/hackatime/callback` });
    if (!t.access_token) return res.status(400).send("hackatime token failed");
    const r = await fetch(`${HACKATIME}/api/v1/authenticated/me`, {
      headers: { Authorization: `Bearer ${t.access_token}` } });
    if (!r.ok) return res.status(400).send("hackatime /me failed");
    const data = await r.json();
    const hid = data.id && String(data.id);
    if (!hid) return res.status(400).send("no hackatime id");
    const taken = Object.values(db.users).find((u) => u.hackatimeId === hid && u.id !== req.session.uid);
    if (taken) return res.status(409).send("that Hackatime account is already linked to another user");
    me(req).hackatimeId = hid; // token not stored; stats are fetched by id
    save();
    res.redirect("/app.html");
  } catch (e) { console.error(e); res.status(500).send("hackatime link error"); }
});

app.post("/api/hackatime/unlink", needLogin, (req, res) => {
  me(req).hackatimeId = null; save(); res.json({ ok: true });
});

// ---------- Hackatime stats ----------
// returns { projects: { name: seconds }, banned } for [from, to]
async function htStats(hid, from, to) {
  const params = { features: "projects", start_date: from.toISOString(), end_date: to.toISOString() };
  const r = await fetch(`${HACKATIME}/api/v1/users/${hid}/stats?` + form(params), {
    headers: { "Content-Type": "application/json", "User-Agent": "docked" } });
  if (!r.ok) throw new Error(`hackatime ${r.status}`);
  const data = await r.json();
  const projects = {};
  for (const p of data?.data?.projects || []) projects[p.name] = Number(p.total_seconds) || 0;
  return { projects, banned: data?.trust_factor?.trust_value === 1 };
}
const windowFor = (w) => [weekStart(w), new Date(Math.min(Date.now(), weekEnd(w).getTime()))];
const pointsFor = (seconds) => Math.floor((seconds / 3600) * PPH);

// ---------- status ----------
app.get("/api/status", (req, res) => {
  const w = currentWeek();
  res.json({
    now: Date.now(), start: START.getTime(), week: w,
    phase: w === 0 ? "before" : w > JAMS.length ? "ended" : "open",
    weekStart: w >= 1 && w <= JAMS.length ? weekStart(w).getTime() : null,
    weekEnd: w >= 1 && w <= JAMS.length ? weekEnd(w).getTime() : null,
    checklist: CHECKLIST, pointsPerHour: PPH, minHours: MINH,
  });
});

// projects with time logged in the current jam week
app.get("/api/hackatime/projects", needLogin, async (req, res) => {
  const u = me(req), w = currentWeek();
  if (!u.hackatimeId) return res.status(400).json({ error: "link Hackatime first" });
  if (w < 1 || w > JAMS.length) return res.json([]);
  try {
    const { projects } = await htStats(u.hackatimeId, ...windowFor(w));
    const used = db.submissions.filter((s) => s.userId === u.id && s.week !== w).map((s) => s.project);
    res.json(Object.entries(projects)
      .filter(([name]) => !used.includes(name))
      .map(([name, seconds]) => ({ name, hours: +(seconds / 3600).toFixed(2) }))
      .sort((a, b) => b.hours - a.hours));
  } catch (e) { console.error(e); res.status(502).json({ error: "could not reach Hackatime" }); }
});

// ---------- jams ----------
app.get("/api/jams", (req, res) => {
  res.json(JAMS.map((j) => ({
    ...j, start: weekStart(j.week).getTime(), end: weekEnd(j.week).getTime(), state: jamState(j.week),
    submissions: db.submissions.filter((s) => s.week === j.week).map((s) => ({
      by: displayName(db.users[s.userId]), title: s.title, url: s.url, repo: s.repo,
      description: s.description, screenshot: s.screenshot ? `/uploads/${s.screenshot}` : null })),
  })));
});

const FORGES = ["github.com", "gitlab.com", "codeberg.org", "bitbucket.org", "sr.ht", "git.sr.ht"];
function validRepo(u) {
  try {
    const x = new URL(u);
    return /^https?:$/.test(x.protocol) && FORGES.includes(x.hostname.replace(/^www\./, "")) &&
      x.pathname.split("/").filter(Boolean).length >= 2;
  } catch { return false; }
}
// data URL -> { buf, ext } after checking size and magic bytes (png/jpeg/webp only)
function parseImage(dataUrl) {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
  if (!m) return null;
  const buf = Buffer.from(m[2], "base64");
  if (buf.length < 100 || buf.length > 3 * 1024 * 1024) return null;
  const ok = m[1] === "png" ? buf.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    : m[1] === "jpeg" ? buf.slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    : buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP";
  return ok ? { buf, ext: m[1] === "jpeg" ? "jpg" : m[1] } : null;
}

// submit/update: only during that jam's week
app.post("/api/jams/:week/submit", needLogin, async (req, res) => {
  const u = me(req), week = Number(req.params.week);
  if (!JAMS.find((j) => j.week === week)) return res.status(404).json({ error: "no such jam" });
  if (jamState(week) !== "open") return res.status(403).json({ error: "this jam is not open for submissions" });
  if (!u.hackatimeId) return res.status(400).json({ error: "link Hackatime first" });

  const { title, description, url, repo, project, checklist, screenshot } = req.body || {};
  const desc = String(description || "").trim();
  if (!title || !String(title).trim()) return res.status(400).json({ error: "title required" });
  if (desc.length < 30) return res.status(400).json({ error: "description must be at least 30 characters" });
  if (desc.length > 1000) return res.status(400).json({ error: "description is over 1000 characters" });
  if (!/^https?:\/\/\S+$/.test(url || "")) return res.status(400).json({ error: "playable link must be an http(s) url" });
  if (!validRepo(repo)) return res.status(400).json({ error: "code link must be a repo on GitHub, GitLab, Codeberg, Bitbucket or SourceHut" });
  if (!project) return res.status(400).json({ error: "pick a Hackatime project" });
  const done = Array.isArray(checklist) ? checklist : [];
  const missing = CHECKLIST.filter((c) => !done.includes(c.key));
  if (missing.length) return res.status(400).json({ error: `finish the checklist (${missing.length} left)` });
  if (db.submissions.some((s) => s.userId === u.id && s.week !== week && s.project === project))
    return res.status(400).json({ error: "that Hackatime project is already used for another jam" });

  let sub = db.submissions.find((s) => s.week === week && s.userId === u.id);
  const img = screenshot ? parseImage(screenshot) : null;
  if (screenshot && !img) return res.status(400).json({ error: "screenshot must be a png, jpg or webp under 3MB" });
  if (!img && !sub?.screenshot) return res.status(400).json({ error: "upload a screenshot" });

  try {
    const { projects, banned } = await htStats(u.hackatimeId, ...windowFor(week));
    if (banned) return res.status(403).json({ error: "account flagged by Hackatime" });
    if (!(project in projects)) return res.status(400).json({ error: "no time logged on that project this week" });
    const seconds = Math.max(sub?.seconds || 0, projects[project]);
    if (seconds < MINH * 3600)
      return res.status(400).json({ error: `need at least ${MINH} hours on that project this week (you have ${(seconds / 3600).toFixed(1)})` });

    if (!sub) { sub = { week, userId: u.id }; db.submissions.push(sub); }
    if (img) {
      const name = `${crypto.randomUUID()}.${img.ext}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, name), img.buf);
      if (sub.screenshot) fs.unlink(path.join(UPLOAD_DIR, sub.screenshot), () => {});
      sub.screenshot = name;
    }
    Object.assign(sub, { title: String(title).trim().slice(0, 100), description: desc, url, repo, project,
      checklist: done, seconds, updatedAt: new Date().toISOString() });
    sub.points = Math.max(sub.points || 0, pointsFor(sub.seconds));
    save();
    res.json({ ok: true, hours: +(sub.seconds / 3600).toFixed(2), points: balance(u) });
  } catch (e) { console.error(e); res.status(502).json({ error: "could not reach Hackatime" }); }
});

// re-pull hours for all my submissions (capped to each jam's week)
app.post("/api/sync", needLogin, async (req, res) => {
  const u = me(req);
  if (!u.hackatimeId) return res.status(400).json({ error: "link Hackatime first" });
  try {
    for (const sub of db.submissions.filter((s) => s.userId === u.id)) {
      if (jamState(sub.week) === "upcoming") continue;
      const { projects, banned } = await htStats(u.hackatimeId, ...windowFor(sub.week));
      if (banned) return res.status(403).json({ error: "account flagged by Hackatime" });
      if (sub.project in projects) {
        sub.seconds = Math.max(sub.seconds || 0, projects[sub.project]);
        sub.points = Math.max(sub.points || 0, pointsFor(sub.seconds));
      }
    }
    save();
    res.json({ points: balance(u) });
  } catch (e) { console.error(e); res.status(502).json({ error: "could not reach Hackatime" }); }
});

// demo only: fake extra hours
app.post("/api/demo/log-hours", needLogin, (req, res) => {
  if (DEMO_MODE !== "true") return res.status(403).json({ error: "demo mode off" });
  const h = Number(req.body.hours);
  if (!(h > 0 && h <= 24)) return res.status(400).json({ error: "hours 0-24" });
  me(req).demoPoints = (me(req).demoPoints || 0) + pointsFor(h * 3600);
  save();
  res.json({ points: balance(me(req)) });
});

// ---------- store ----------
app.get("/api/store", (req, res) => res.json(STORE));

app.post("/api/store/redeem", needLogin, (req, res) => {
  const item = STORE.find((i) => i.id === req.body?.itemId);
  if (!item) return res.status(404).json({ error: "no such item" });
  const u = me(req);
  if (balance(u) < item.cost) return res.status(400).json({ error: "not enough points" });
  u.spentPoints = (u.spentPoints || 0) + item.cost;
  db.orders.push({ userId: u.id, itemId: item.id, cost: item.cost, at: new Date().toISOString() });
  save();
  res.json({ ok: true, points: balance(u) });
});

// ---------- me ----------
app.get("/api/me", (req, res) => {
  const u = me(req);
  if (!u) return res.json(null);
  res.json({
    name: displayName(u), githubLinked: !!u.githubId, hcaLinked: !!u.hcaId, hackatimeLinked: !!u.hackatimeId,
    hours: +hoursOf(u).toFixed(2), points: balance(u),
    submissions: db.submissions.filter((s) => s.userId === u.id).map((s) => ({
      week: s.week, title: s.title, url: s.url, repo: s.repo, description: s.description,
      screenshot: s.screenshot ? `/uploads/${s.screenshot}` : null, project: s.project, checklist: s.checklist,
      hours: +((s.seconds || 0) / 3600).toFixed(2), points: s.points || 0 })),
    orders: db.orders.filter((o) => o.userId === u.id),
    demoMode: DEMO_MODE === "true",
  });
});

app.post("/auth/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.use("/uploads", express.static(UPLOAD_DIR, { setHeaders: (r) => r.set("X-Content-Type-Options", "nosniff") }));
app.use(express.static(path.join(__dirname, "public")));
app.listen(PORT, () => console.log(`Docked on ${BASE_URL}`));
