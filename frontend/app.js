const $ = sel => document.querySelector(sel);

let entries = {};
let username = '';
let startKey = '';          // first trackable day, from the server
let calMonth = startOfMonth(new Date());
let targetKey = '';         // the day being updated
let slipCount = 1;

// ---------- Helpers ----------
function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseKey(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function todayKey() {
  return dateKey(new Date());
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addDays(d, n) {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
}

function prettyDate(k, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  return parseKey(k).toLocaleDateString(undefined, opts);
}

function inRange(k) {
  return k >= startKey && k <= todayKey();
}

// Days can be edited freely until locked; locking is only allowed once the day is over
function canEdit(k) {
  return inRange(k) && !entries[k]?.locked;
}

function canLock(k) {
  return canEdit(k) && !!entries[k] && k < todayKey();
}

// Past days in range that still need an update, or are saved but not locked
function pastDays(test) {
  const out = [];
  for (let d = parseKey(startKey); dateKey(d) < todayKey(); d = addDays(d, 1)) {
    if (test(dateKey(d))) out.push(dateKey(d));
  }
  return out;
}

// green = kept, red = broke once, black = broke 2+ times
function colorOf(entry) {
  if (!entry) return '';
  if (entry.kept) return 'green';
  return entry.count >= 2 ? 'black' : 'red';
}

function marksOf(entry) {
  if (!entry || entry.kept) return '';
  return entry.count <= 4 ? 'X'.repeat(entry.count) : `X×${entry.count}`;
}

function dayPreview(el, k, entry) {
  el.className = `day day-preview ${colorOf(entry)}`;
  el.innerHTML = `<span class="num">${parseKey(k).getDate()}</span><span class="marks">${marksOf(entry)}</span>`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin'
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') {
    showView('login');
    throw new Error('Please log in again');
  }
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

// Live date and clock in the page frame corners
function tickCorners() {
  const now = new Date();
  $('#corner-date').textContent = now.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  $('#corner-clock').textContent = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
tickCorners();
setInterval(tickCorners, 1000);

// ---------- Views ----------
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(`#view-${name}`).classList.add('active');
  scrollTo(0, 0);
  if (name === 'hub') renderHub();
  if (name === 'today') renderUpdate();
  if (name === 'calendar') renderCalendar();
}

// Ink bars drop over the page with a word, then lift away to reveal the next view
function shutterTo(name, word) {
  const shutter = $('#shutter');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  $('#shutter-word').textContent = word;
  shutter.className = 'shutter closing';
  setTimeout(() => {
    showView(name);
    shutter.className = 'shutter opening';
    setTimeout(() => (shutter.className = 'shutter'), reduced ? 0 : 850);
  }, reduced ? 0 : 1500);
}

document.addEventListener('click', e => {
  const go = e.target.closest('[data-go]');
  if (go) {
    if (go.dataset.go === 'today') targetKey = todayKey();
    showView(go.dataset.go);
  }
  if (e.target.closest('[data-logout]')) logout();
});

// ---------- Auth ----------
$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = form.querySelector('button[type=submit]');
  const error = $('#login-error');
  error.textContent = '';
  const body = { username: $('#username').value.trim(), password: $('#password').value };
  if (!body.username || !body.password) {
    error.textContent = 'Enter your login ID and password';
    return;
  }
  btn.disabled = true;
  try {
    const data = await api('/api/login', { method: 'POST', body: JSON.stringify(body) });
    $('#password').value = '';
    await afterLogin(data);
  } catch (err) {
    error.textContent = err.message;
    form.classList.remove('shake');
    void form.offsetWidth;
    form.classList.add('shake');
  } finally {
    btn.disabled = false;
  }
});

async function afterLogin(session) {
  username = session.username;
  startKey = session.startDate;
  calMonth = startOfMonth(new Date());
  document.querySelectorAll('.js-username').forEach(el => (el.textContent = username));
  entries = await api('/api/entries');
  showView('welcome');
}

async function logout() {
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  entries = {};
  showView('login');
}

$('#get-started').addEventListener('click', () => shutterTo('hub', 'Let’s begin.'));

// ---------- Stats ----------
function currentStreak() {
  let d = new Date();
  const today = entries[dateKey(d)];
  if (today && !today.kept) return 0;
  if (!today) d = addDays(d, -1); // today not logged yet, count up to yesterday
  let n = 0;
  while (entries[dateKey(d)]?.kept) {
    n++;
    d = addDays(d, -1);
  }
  return n;
}

// Longest run of consecutive green days; a red/black or missing day ends a run
function bestStreak() {
  let best = 0, run = 0, prev = null;
  for (const k of Object.keys(entries).sort()) {
    if (!entries[k].kept) { run = 0; prev = null; continue; }
    const d = parseKey(k);
    run = prev && Math.round((d - prev) / 864e5) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

function computeStats() {
  const all = Object.values(entries);
  const kept = all.filter(e => e.kept).length;
  const xTotal = all.reduce((sum, e) => sum + (e.kept ? 0 : e.count), 0);
  return {
    current: currentStreak(),
    best: bestStreak(),
    kept,
    broken: all.length - kept,
    logged: all.length,
    xTotal,
    xAvg: all.length ? xTotal / all.length : 0,
    rate: all.length ? Math.round((kept / all.length) * 100) : 0
  };
}

// ---------- Hub ----------
function renderHub() {
  const n = currentStreak();
  $('#hub-streak-num').textContent = String(n).padStart(2, '0');
  $('#hub-streak-label').textContent = n ? 'day streak — keep going' : 'day streak — start one today';
  const missed = pastDays(k => !entries[k]).length;
  const ready = pastDays(k => canLock(k)).length;
  const notes = [];
  if (missed) notes.push(`${missed} day${missed > 1 ? 's' : ''} to update`);
  if (ready) notes.push(`${ready} ready to lock`);
  $('#calendar-desc').textContent = notes.length ? `${notes.join(' · ')}.` : 'Every day, at a glance.';
}

// ---------- Update a day ----------
function showStep(id) {
  ['#step-ask', '#step-count', '#step-confirm', '#step-done'].forEach(s => ($(s).hidden = s !== id));
}

function renderUpdate() {
  const isToday = targetKey === todayKey();
  const long = prettyDate(targetKey, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('#today-date').textContent = long;

  if (!inRange(targetKey)) {
    showClosed(targetKey < startKey
      ? `Tracking starts on ${prettyDate(startKey, { day: 'numeric', month: 'long', year: 'numeric' })}.`
      : 'Future days can’t be updated yet.');
    return;
  }
  if (entries[targetKey]) {
    showDetail(false);
    return;
  }
  askDay();
}

// Yes / No question for the target day (also used when editing)
function askDay() {
  const isToday = targetKey === todayKey();
  const entry = entries[targetKey];
  $('#ask-label').textContent = entry ? '(04) — Edit day' : isToday ? '(04) — Today’s update' : '(04) — Missed day';
  $('#ask-question').innerHTML = isToday
    ? 'Did you maintain<br>today’s <em>streak?</em>'
    : `Did you keep the streak<br>on <em>${prettyDate(targetKey)}?</em>`;
  $('#today-current').textContent = entry
    ? 'You can change this until the day is locked.'
    : 'You can edit this until you lock the day.';
  slipCount = entry && !entry.kept ? entry.count : 1;
  showStep('#step-ask');
}

function restartStamp(stamp) {
  stamp.style.animation = 'none';
  void stamp.offsetWidth;
  stamp.style.animation = '';
}

function showClosed(text) {
  const stamp = $('#done-stamp');
  stamp.className = 'stamp worse';
  stamp.textContent = 'Not open';
  $('#done-label').textContent = '(04) — Closed';
  $('#done-title').innerHTML = 'This day is <em>closed.</em>';
  $('#done-text').textContent = text;
  $('#done-actions').hidden = true;
  $('#lock-note').hidden = true;
  showStep('#step-done');
  restartStamp(stamp);
}

function renderCount() {
  $('#count-value').textContent = slipCount;
  dayPreview($('#count-preview'), targetKey, { kept: false, count: slipCount });
  document.querySelectorAll('#count-chips button').forEach(b => b.classList.toggle('on', Number(b.dataset.n) === slipCount));
}

$('#count-chips').innerHTML = [1, 2, 3, 4, 5].map(n => `<button type="button" data-n="${n}">${n}</button>`).join('');
$('#count-chips').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  slipCount = Number(b.dataset.n);
  renderCount();
});
$('#count-minus').addEventListener('click', () => { slipCount = Math.max(1, slipCount - 1); renderCount(); });
$('#count-plus').addEventListener('click', () => { slipCount = Math.min(99, slipCount + 1); renderCount(); });
$('#count-back').addEventListener('click', () => showStep('#step-ask'));
$('#btn-no').addEventListener('click', () => { showStep('#step-count'); renderCount(); });
$('#btn-yes').addEventListener('click', () => saveDay({ kept: true }, $('#btn-yes')));
$('#count-save').addEventListener('click', () => saveDay({ kept: false, count: slipCount }, $('#count-save')));
$('#detail-edit').addEventListener('click', askDay);
$('#detail-lock').addEventListener('click', askLock);
$('#confirm-back').addEventListener('click', () => showDetail(false));
$('#confirm-lock').addEventListener('click', lockDay);

async function saveDay(body, btn) {
  btn.disabled = true;
  try {
    entries[targetKey] = await api(`/api/entries/${targetKey}`, { method: 'PUT', body: JSON.stringify(body) });
    showDetail(true);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

function askLock() {
  const entry = entries[targetKey];
  dayPreview($('#confirm-preview'), targetKey, entry);
  const when = prettyDate(targetKey, { weekday: 'long', day: 'numeric', month: 'long' });
  $('#confirm-text').textContent = entry.kept
    ? `Lock ${when} as kept (green).`
    : `Lock ${when} as broken with ${marksOf(entry)} (${entry.count} negative point${entry.count > 1 ? 's' : ''}).`;
  showStep('#step-confirm');
}

async function lockDay() {
  const btn = $('#confirm-lock');
  btn.disabled = true;
  try {
    entries[targetKey] = await api(`/api/entries/${targetKey}/lock`, { method: 'POST' });
    showDetail(false, true);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

// Stamp + status for a day that has values, with Edit / Lock when allowed
function showDetail(justSaved, justLocked = false) {
  const entry = entries[targetKey];
  const stamp = $('#done-stamp');
  const isToday = targetKey === todayKey();
  const when = isToday ? 'Today' : prettyDate(targetKey);
  const value = entry.kept ? 'kept (green)' : `broken with ${marksOf(entry)}`;

  stamp.className = `stamp ${entry.kept ? 'good' : entry.count >= 2 ? 'worse' : 'bad'}`;
  stamp.textContent = entry.kept ? 'Kept ✓' : `Broken ${marksOf(entry)}`;

  if (entry.locked) {
    $('#done-label').textContent = '(04) — Locked';
    $('#done-title').innerHTML = justLocked ? 'Locked <em>in.</em>' : 'Already <em>locked.</em>';
    $('#done-text').textContent = `${when} is ${value}. Locked days can’t be changed.`;
  } else if (justSaved) {
    $('#done-label').textContent = '(04) — Saved';
    $('#done-title').innerHTML = entry.kept ? 'Nicely <em>done.</em>' : 'Tomorrow is a <em>fresh page.</em>';
    $('#done-text').textContent = `${when} is saved as ${value}.` +
      (entry.kept ? ` Current streak: ${currentStreak()} day${currentStreak() === 1 ? '' : 's'}.` : '');
  } else {
    $('#done-label').textContent = '(04) — Not locked yet';
    $('#done-title').innerHTML = `Saved, <em>not locked.</em>`;
    $('#done-text').textContent = `${when} is saved as ${value}. You can still edit it.`;
  }

  $('#done-actions').hidden = !!entry.locked;
  $('#detail-lock').hidden = !canLock(targetKey);
  $('#lock-note').hidden = !!entry.locked || canLock(targetKey);
  $('#lock-note-text').textContent = 'You can lock this day from tomorrow, in the calendar.';

  showStep('#step-done');
  restartStamp(stamp);
}

// ---------- Calendar ----------
const firstMonth = () => startOfMonth(parseKey(startKey));
const lastMonth = () => startOfMonth(new Date());

$('#prev-month').addEventListener('click', () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1); renderCalendar(); });
$('#next-month').addEventListener('click', () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1); renderCalendar(); });

$('#cal-grid').addEventListener('click', e => {
  const cell = e.target.closest('button.day');
  if (!cell) return;
  const k = cell.dataset.key;
  if (entries[k]?.locked) return toast(`${prettyDate(k)} is locked and can’t be changed`);
  if (k < startKey) return toast(`Tracking starts on ${prettyDate(startKey)}`);
  if (k > todayKey()) return toast('You can’t update a future day');
  targetKey = k;
  showView('today');
});

function renderCalendar() {
  if (calMonth < firstMonth()) calMonth = firstMonth();
  if (calMonth > lastMonth()) calMonth = lastMonth();
  $('#prev-month').disabled = calMonth <= firstMonth();
  $('#next-month').disabled = calMonth >= lastMonth();

  $('#month-label').innerHTML = `<em>${calMonth.toLocaleDateString(undefined, { month: 'long' })}</em> ${calMonth.getFullYear()}`;
  const today = todayKey();
  const daysInMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < calMonth.getDay(); i++) cells.push('<div class="day empty"></div>');
  for (let d = 1; d <= daysInMonth; d++) {
    const k = dateKey(new Date(calMonth.getFullYear(), calMonth.getMonth(), d));
    const entry = entries[k];
    const blank = inRange(k) && !entry;
    const classes = [
      'day',
      colorOf(entry),
      k === today ? 'today' : '',
      entry?.locked ? 'locked' : '',
      canLock(k) ? 'ready' : '',
      entry && !entry.locked ? 'editable' : '',
      blank ? 'open' : '',
      blank && k < today ? 'missed' : '',
      inRange(k) ? '' : 'off'
    ].join(' ');
    const value = entry ? (entry.kept ? 'Kept' : `Broke ${entry.count} time${entry.count > 1 ? 's' : ''}`) : '';
    const title = entry?.locked ? `${value} — locked`
      : canLock(k) ? `${value} — click to edit or lock`
      : entry ? `${value} — can be locked from tomorrow`
      : blank ? 'Click to update' : k > today ? 'Future day' : 'Before tracking started';
    cells.push(`<button class="${classes}" data-key="${k}" title="${title}" style="animation-delay:${d * 12}ms"><span class="num">${d}</span><span class="marks">${marksOf(entry)}</span></button>`);
  }
  $('#cal-grid').innerHTML = cells.join('');
  renderStats();
}

function renderStats() {
  const s = computeStats();
  const strip = [];
  for (let i = 29; i >= 0; i--) {
    const entry = entries[dateKey(addDays(new Date(), -i))];
    strip.push(`<i class="${colorOf(entry)}"></i>`);
  }
  const tile = (no, value, label, delay) =>
    `<div class="stat" style="animation-delay:${delay}ms"><div class="label">${no} — ${label}</div><div class="value">${value}</div></div>`;
  $('#stats').innerHTML = `
    <div class="stat feature">
      <div class="label">i — Success rate</div>
      <div class="value">${s.rate}<small>%</small></div>
      <div>
        <div class="bar"><span style="transform:scaleX(${s.rate / 100})"></span></div>
        <p class="bar-caption">${s.kept} of ${s.logged} updated days kept.</p>
      </div>
    </div>
    ${tile('ii', s.current, 'Current streak', 60)}
    ${tile('iii', s.best, 'Highest streak', 120)}
    ${tile('iv', s.kept, 'Green days', 180)}
    ${tile('v', s.broken, 'Broken days', 240)}
    ${tile('vi', s.xTotal ? `−${s.xTotal}` : '0', 'Total X (negative points)', 300)}
    ${tile('vii', s.xAvg.toFixed(2), 'Average X per day', 360)}
    <div class="stat wide" style="animation-delay:420ms">
      <div class="label">viii — Last 30 days</div>
      <div class="strip">${strip.join('')}</div>
    </div>`;
}

// ---------- Start ----------
(async function init() {
  try {
    const s = await api('/api/session');
    if (s.loggedIn) return afterLogin(s);
  } catch {}
  showView('login');
})();
