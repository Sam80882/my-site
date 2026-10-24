// Streak API on Netlify Functions. Data lives in Netlify Blobs; login comes from environment variables:
//   STREAK_USERNAME, STREAK_PASSWORD   (required)
//   STREAK_START_DATE                  first trackable day, e.g. 2026-10-24 (defaults to today)
//   STREAK_TIMEZONE                    what "today" means, e.g. Asia/Kolkata (default)
//   SESSION_SECRET                     optional; signs login cookies (derived from the login if unset)
import { getStore } from '@netlify/blobs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const SESSION_DAYS = 7;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const env = name => (process.env[name] || '').trim();

function todayKey() {
  // en-CA formats dates as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: env('STREAK_TIMEZONE') || 'Asia/Kolkata' }).format(new Date());
}

function isRealDate(k) {
  if (!DATE_RE.test(k)) return false;
  const d = new Date(`${k}T00:00:00Z`);
  return !isNaN(d) && d.toISOString().slice(0, 10) === k;
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

// ---------- Sessions: signed cookie, no server-side state ----------
function secret() {
  return env('SESSION_SECRET') || createHash('sha256').update(`streak:${env('STREAK_USERNAME')}:${env('STREAK_PASSWORD')}`).digest('hex');
}

function sign(payload) {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

function newSessionCookie() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  return `sid=${payload}.${sign(payload)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
}

function isLoggedIn(req) {
  const match = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.get('cookie') || '');
  if (!match) return false;
  const [payload, sig] = match[1].split('.');
  if (!payload || !sig || !sameText(sig, sign(payload))) return false;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now();
  } catch {
    return false;
  }
}

// ---------- Storage ----------
const store = () => getStore({ name: 'streak', consistency: 'strong' });
const loadEntries = async () => (await store().get('entries', { type: 'json' })) || {};
const saveEntries = entries => store().setJSON('entries', entries);

async function readBody(req) {
  const text = await req.text();
  if (text.length > 10_000) throw new Error('Body too large');
  return text ? JSON.parse(text) : {};
}

export default async (req) => {
  const username = env('STREAK_USERNAME');
  const password = env('STREAK_PASSWORD');
  if (!username || !password) {
    return json(500, { error: 'Server is missing STREAK_USERNAME / STREAK_PASSWORD settings' });
  }
  const startDate = isRealDate(env('STREAK_START_DATE')) ? env('STREAK_START_DATE') : todayKey();
  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  const method = req.method;

  try {
    if (path === '/api/login' && method === 'POST') {
      const body = await readBody(req);
      if (sameText(body.username ?? '', username) && sameText(body.password ?? '', password)) {
        return json(200, { username, startDate }, { 'Set-Cookie': newSessionCookie() });
      }
      await new Promise(r => setTimeout(r, 600)); // slow down guessing
      return json(401, { error: 'Wrong login ID or password' });
    }

    const loggedIn = isLoggedIn(req);

    if (path === '/api/session' && method === 'GET') {
      return json(200, loggedIn ? { loggedIn: true, username, startDate } : { loggedIn: false });
    }

    if (!loggedIn) return json(401, { error: 'Not logged in' });

    if (path === '/api/logout' && method === 'POST') {
      return json(200, { ok: true }, { 'Set-Cookie': 'sid=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
    }

    if (path === '/api/entries' && method === 'GET') {
      return json(200, await loadEntries());
    }

    const m = /^\/api\/entries\/(\d{4}-\d{2}-\d{2})(\/lock)?$/.exec(path);
    if (m) {
      const [, date, lock] = m;
      if (!isRealDate(date)) return json(400, { error: 'Invalid date' });
      const today = todayKey();
      if (date < startDate || date > today) {
        return json(400, { error: `Only days from ${startDate} to today can be updated` });
      }
      const entries = await loadEntries();
      const existing = entries[date];
      if (existing?.locked) return json(409, { error: 'This day is locked and can no longer be changed' });

      // Locking is separate from saving, and only allowed once the day is over
      if (lock) {
        if (method !== 'POST') return json(405, { error: 'Use POST to lock' });
        if (!existing) return json(400, { error: 'Update this day before locking it' });
        if (date >= today) return json(400, { error: 'A day can only be locked after it is over' });
        existing.locked = true;
        await saveEntries(entries);
        return json(200, existing);
      }

      if (method !== 'PUT') return json(405, { error: 'Use PUT to update' });
      const body = await readBody(req);
      let entry;
      if (body.kept === true) {
        entry = { kept: true };
      } else if (body.kept === false) {
        const count = Number(body.count);
        if (!Number.isInteger(count) || count < 1 || count > 99) {
          return json(400, { error: 'Count must be between 1 and 99' });
        }
        entry = { kept: false, count };
      } else {
        return json(400, { error: '"kept" must be true or false' });
      }
      entries[date] = entry;
      await saveEntries(entries);
      return json(200, entry);
    }

    return json(404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Server error' });
  }
};

export const config = { path: '/api/*' };
