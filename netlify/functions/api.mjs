// Streak API on Netlify Functions. Data lives in the Supabase table daily_entries; secrets come from
// environment variables (kept out of the public repo):
//   STREAK_USERS                                 login IDs, comma-separated, e.g. "sharath,anil,ravi"
//                                                (falls back to the single STREAK_USERNAME)
//   STREAK_PASSWORD                              (required) the password every account shares
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY      (required) server-only database access; RLS stays on with no policies
//   SESSION_SECRET                               optional; signs login cookies (derived from the password if unset)
// Every row carries its owner's username, and every query is filtered by the logged-in user, so accounts never mix.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const START_DATE = '2026-11-01';   // first day that can be tracked
const TIMEZONE = 'Asia/Kolkata';   // what "today" means
const SESSION_DAYS = 7;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const USER_RE = /^[a-z0-9_.-]{1,32}$/;

const env = name => (process.env[name] || '').trim();

function users() {
  return (env('STREAK_USERS') || env('STREAK_USERNAME'))
    .split(',')
    .map(u => u.trim().toLowerCase())
    .filter(u => USER_RE.test(u));
}

function todayKey() {
  // en-CA formats dates as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(new Date());
}

function isRealDate(k) {
  if (!DATE_RE.test(k)) return false;
  const d = new Date(`${k}T00:00:00Z`);
  return !isNaN(d) && d.toISOString().slice(0, 10) === k;
}

function addDaysKey(k, n) {
  const d = new Date(`${k}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
  });
}

function sameText(a, b) {
  // Compare hashes so lengths always match and timing doesn't leak
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

// ---------- Sessions: signed cookie naming the user, no server-side state ----------
function secret() {
  return env('SESSION_SECRET') || createHash('sha256').update(`streak:${env('STREAK_PASSWORD')}`).digest('hex');
}

function sign(payload) {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

function newSessionCookie(user) {
  const payload = Buffer.from(JSON.stringify({ u: user, exp: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  return `sid=${payload}.${sign(payload)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
}

// The logged-in username, or null
function sessionUser(req) {
  const match = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.get('cookie') || '');
  if (!match) return null;
  const [payload, sig] = match[1].split('.');
  if (!payload || !sig || !sameText(sig, sign(payload))) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return exp > Date.now() && users().includes(u) ? u : null;
  } catch {
    return null;
  }
}

// ---------- Storage: Supabase REST (PostgREST) with the service role key ----------
async function db(query, options = {}) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const res = await fetch(`${env('SUPABASE_URL').replace(/\/+$/, '')}/rest/v1/daily_entries${query}`, {
    ...options,
    headers: {
      apikey: key,
      // Legacy service_role keys are JWTs and also go in Authorization; new sb_secret_ keys only use apikey
      ...(key.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}),
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...options.headers
    }
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

const byUser = user => `username=eq.${encodeURIComponent(user)}`;

// Row in the table -> the shape the frontend uses
function toEntry(row) {
  const entry = row.kept ? { kept: true } : { kept: false, count: row.count };
  if (row.locked) entry.locked = true;
  return entry;
}

async function loadEntries(user) {
  const rows = await db(`?select=entry_date,kept,count,locked&${byUser(user)}&entry_date=gte.${START_DATE}&order=entry_date`);
  return Object.fromEntries(rows.map(r => [r.entry_date, toEntry(r)]));
}

async function getEntry(user, date) {
  const rows = await db(`?select=entry_date,kept,count,locked&${byUser(user)}&entry_date=eq.${date}`);
  return rows[0] ? toEntry(rows[0]) : null;
}

// Updates only touch unlocked rows, so a locked day can never change
async function writeEntry(user, date, fields, exists) {
  const rows = exists
    ? await db(`?${byUser(user)}&entry_date=eq.${date}&locked=is.false`, { method: 'PATCH', body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }) })
    : await db('', { method: 'POST', body: JSON.stringify({ username: user, entry_date: date, ...fields }) });
  return rows[0] ? toEntry(rows[0]) : null;
}

// ---------- Leaderboard: totals only, never anyone's individual days ----------
function summarise(entries, today) {
  const keys = Object.keys(entries).sort();
  let kept = 0, x = 0;
  for (const k of keys) {
    if (entries[k].kept) kept++;
    else x += entries[k].count;
  }
  const logged = keys.length;

  // Current streak: green days in a row up to today (today still counts as open until it's answered)
  let current = 0;
  let d = today;
  if (entries[d] && !entries[d].kept) d = null;
  else if (!entries[d]) d = addDaysKey(d, -1);
  while (d && entries[d]?.kept) { current++; d = addDaysKey(d, -1); }

  // Best streak: longest run of consecutive green days
  let best = 0, run = 0, prev = null;
  for (const k of keys) {
    if (!entries[k].kept) { run = 0; prev = null; continue; }
    run = prev && addDaysKey(prev, 1) === k ? run + 1 : 1;
    best = Math.max(best, run);
    prev = k;
  }

  return { kept, broken: logged - kept, logged, x, rate: logged ? Math.round((kept / logged) * 100) : 0, current, best };
}

async function leaderboard() {
  const people = users();
  const rows = await db(`?select=username,entry_date,kept,count&entry_date=gte.${START_DATE}&order=entry_date`);
  const today = todayKey();
  return people.map(name => {
    const mine = Object.fromEntries(rows.filter(r => r.username === name).map(r => [r.entry_date, toEntry(r)]));
    return { name, ...summarise(mine, today) };
  });
}

async function readBody(req) {
  const text = await req.text();
  if (text.length > 10_000) throw new Error('Body too large');
  return text ? JSON.parse(text) : {};
}

export default async (req) => {
  const password = env('STREAK_PASSWORD');
  if (!users().length || !password) {
    return json(500, { error: 'Server is missing STREAK_USERS / STREAK_PASSWORD settings' });
  }
  if (!env('SUPABASE_URL') || !env('SUPABASE_SERVICE_ROLE_KEY')) {
    return json(500, { error: 'Server is missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY settings' });
  }
  const startDate = START_DATE;
  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  const method = req.method;

  try {
    if (path === '/api/login' && method === 'POST') {
      const body = await readBody(req);
      const name = String(body.username ?? '').trim().toLowerCase();
      // Check every account so timing doesn't reveal which IDs exist
      const known = users().reduce((hit, u) => sameText(name, u) || hit, false);
      if (known && sameText(body.password ?? '', password)) {
        return json(200, { username: name, startDate }, { 'Set-Cookie': newSessionCookie(name) });
      }
      await new Promise(r => setTimeout(r, 600)); // slow down guessing
      return json(401, { error: 'Wrong login ID or password' });
    }

    const user = sessionUser(req);

    if (path === '/api/session' && method === 'GET') {
      return json(200, user ? { loggedIn: true, username: user, startDate } : { loggedIn: false });
    }

    if (!user) return json(401, { error: 'Not logged in' });

    if (path === '/api/logout' && method === 'POST') {
      return json(200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
    }

    if (path === '/api/entries' && method === 'GET') {
      return json(200, await loadEntries(user));
    }

    if (path === '/api/leaderboard' && method === 'GET') {
      return json(200, { you: user, people: await leaderboard() });
    }

    const m = /^\/api\/entries\/(\d{4}-\d{2}-\d{2})(\/lock)?$/.exec(path);
    if (m) {
      const [, date, lock] = m;
      if (!isRealDate(date)) return json(400, { error: 'Invalid date' });
      const today = todayKey();
      if (date < startDate || date > today) {
        return json(400, { error: `Only days from ${startDate} to today can be updated` });
      }
      const existing = await getEntry(user, date);
      const lockedError = () => json(409, { error: 'This day is locked and can no longer be changed' });
      if (existing?.locked) return lockedError();

      // Locking is separate from saving, and only allowed once the day is over
      if (lock) {
        if (method !== 'POST') return json(405, { error: 'Use POST to lock' });
        if (!existing) return json(400, { error: 'Update this day before locking it' });
        if (date >= today) return json(400, { error: 'A day can only be locked after it is over' });
        const locked = await writeEntry(user, date, { locked: true }, true);
        return locked ? json(200, locked) : lockedError();
      }

      if (method !== 'PUT') return json(405, { error: 'Use PUT to update' });
      const body = await readBody(req);
      let fields;
      if (body.kept === true) {
        fields = { kept: true, count: null };
      } else if (body.kept === false) {
        const count = Number(body.count);
        if (!Number.isInteger(count) || count < 1 || count > 99) {
          return json(400, { error: 'Count must be between 1 and 99' });
        }
        fields = { kept: false, count };
      } else {
        return json(400, { error: '"kept" must be true or false' });
      }
      const saved = await writeEntry(user, date, fields, !!existing);
      return saved ? json(200, saved) : lockedError();
    }

    return json(404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Server error' });
  }
};

export const config = { path: '/api/*' };
