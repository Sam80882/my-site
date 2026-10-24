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
  document.body.dataset.view = name;
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
const QUOTES = [
  'Small steps, every single day.',
  'You don’t have to be perfect. Just keep showing up.',
  'One honest day at a time.',
  'A slip is a data point, not a verdict.',
  'Momentum is built, not found.',
  'Today counts. So does tomorrow.',
  'Progress over perfection.',
  'The climb is made of ordinary days.',
  'Start again as many times as it takes.',
  'Be proud of the days you kept.'
];

function renderHub() {
  const n = currentStreak();
  $('#hub-streak-num').textContent = String(n).padStart(2, '0');
  $('#hub-streak-label').textContent = n ? 'day streak — keep going' : 'day streak — start one today';

  // A new line each day
  const dayNo = Math.floor(parseKey(todayKey()).getTime() / 864e5);
  $('#hub-quote').textContent = QUOTES[dayNo % QUOTES.length];

  const today = entries[todayKey()];
  const status = $('#today-status');
  status.className = `today-status ${!today ? '' : today.kept ? 'kept' : 'broken'}`;
  status.textContent = !today ? 'Today: not updated yet — open Today’s update below.'
    : today.kept ? 'Today: kept ✓ — nice work.'
    : `Today: ${marksOf(today)} — tomorrow is a fresh page.`;

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
  const days = chartDays();
  const span = days.length === 1 ? 'today' : `the last ${days.length} days`;
  const tile = (no, value, label, delay, color, hint) =>
    `<div class="stat" style="animation-delay:${delay}ms;--c:var(--${color})"><div class="label">${no} — ${label}</div><div class="value">${value}</div><p class="stat-hint">${hint}</p></div>`;
  $('#stats').innerHTML = `
    <div class="stat feature">
      <div class="label">i — Success rate</div>
      <div class="value">${s.rate}<small>%</small></div>
      <div>
        <div class="bar"><span style="transform:scaleX(${s.rate / 100})"></span></div>
        <p class="bar-caption">${s.kept} of ${s.logged} updated days kept. Higher is better.</p>
      </div>
    </div>
    ${tile('ii', s.current, 'Current streak', 60, 'amber', 'Green days in a row, up to today.')}
    ${tile('iii', s.best, 'Highest streak', 120, 'violet', 'Your longest run of green days. It stays even after a break.')}
    ${tile('iv', s.kept, 'Green days', 180, 'teal', 'Days you kept the streak.')}
    ${tile('v', s.broken, 'Broken days', 240, 'coral', 'Days marked red or black.')}
    ${tile('vi', s.xTotal ? `−${s.xTotal}` : '0', 'Total X (negative points)', 300, 'pink', 'Every X mark counts as one negative point.')}
    ${tile('vii', s.xAvg.toFixed(2), 'Average X per day', 360, 'pink', 'Total X ÷ updated days. Lower is better.')}
    <div class="stat wide chart-card" style="animation-delay:420ms">
      <div class="label">viii — Daily results</div>
      <p class="stat-hint">Each bar is one day of ${span}. Up means you kept it. Down shows how many X marks that day got.</p>
      <div class="chart-legend">
        <span><i class="sw green"></i>Kept (+1)</span>
        <span><i class="sw red"></i>X marks (−1 each)</span>
        <span><i class="sw none"></i>Not updated</span>
      </div>
      <div class="chart" id="chart-daily"></div>
    </div>
    <div class="stat wide chart-card" style="animation-delay:480ms">
      <div class="label">ix — Streak over time</div>
      <p class="stat-hint">How many green days in a row you had on each day. It climbs while you keep going and drops to 0 when the streak breaks.</p>
      <div class="chart" id="chart-streak"></div>
      <details class="table-view">
        <summary>Show as table</summary>
        <table>
          <thead><tr><th>Day</th><th>Result</th><th>Streak</th></tr></thead>
          <tbody id="chart-table"></tbody>
        </table>
      </details>
    </div>`;
  drawCharts();
}

// ---------- Charts ----------
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

// Up to the last 30 days, never before the start date
function chartDays() {
  const out = [];
  let d = addDays(new Date(), -29);
  if (dateKey(d) < startKey) d = parseKey(startKey);
  for (; dateKey(d) <= todayKey(); d = addDays(d, 1)) out.push(dateKey(d));
  return out;
}

// Green days in a row on each day; today counts as "not over yet" until updated
function streakSeries(days) {
  let run = 0;
  for (let d = addDays(parseKey(days[0]), -1); entries[dateKey(d)]?.kept; d = addDays(d, -1)) run++;
  return days.map(k => {
    const e = entries[k];
    if (e?.kept) run++;
    else if (e || k !== todayKey()) run = 0;
    return run;
  });
}

function resultText(e) {
  if (!e) return 'Not updated';
  return e.kept ? 'Kept ✓' : `${e.count} X mark${e.count > 1 ? 's' : ''}`;
}

function tipFor(box) {
  let tip = box.querySelector('.chart-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    box.appendChild(tip);
  }
  return tip;
}

function showTip(box, x, y, value, label) {
  const tip = tipFor(box);
  const strong = document.createElement('strong');
  strong.textContent = value;
  const span = document.createElement('span');
  span.textContent = label;
  tip.replaceChildren(strong, span);
  tip.hidden = false;
  tip.style.left = `${Math.min(Math.max(x - tip.offsetWidth / 2, 0), box.clientWidth - tip.offsetWidth)}px`;
  tip.style.top = `${Math.max(y - tip.offsetHeight - 10, 0)}px`;
}

function hideTip(box) {
  tipFor(box).hidden = true;
}

// Column with a 4px rounded end away from the baseline
function barPath(x, y0, w, y1) {
  const r = Math.min(4, w / 2, Math.abs(y1 - y0));
  const dir = y1 < y0 ? 1 : -1;
  return `M${x},${y0} V${y1 + dir * r} Q${x},${y1} ${x + r},${y1} H${x + w - r} Q${x + w},${y1} ${x + w},${y1 + dir * r} V${y0} Z`;
}

function addTick(svg, x, y, text, anchor = 'end') {
  const t = svgEl('text', { x, y, 'text-anchor': anchor, class: 'tick' });
  t.textContent = text;
  svg.appendChild(t);
}

function addDateLabels(svg, days, xAt, y, left, right) {
  const short = k => (k === todayKey() ? 'Today' : prettyDate(k, { day: 'numeric', month: 'short' }));
  addTick(svg, left, y, short(days[0]), 'start');
  if (days.length > 1) addTick(svg, right, y, short(days[days.length - 1]), 'end');
  if (days.length > 8) {
    const mid = Math.floor((days.length - 1) / 2);
    addTick(svg, xAt(mid), y, short(days[mid]), 'middle');
  }
}

function drawCharts() {
  const days = chartDays();
  const daily = $('#chart-daily');
  const streak = $('#chart-streak');
  if (!daily || !streak) return;
  if (!days.length) {
    daily.innerHTML = streak.innerHTML = '<p class="chart-empty">Nothing to show yet.</p>';
    return;
  }
  const series = streakSeries(days);
  drawDaily(daily, days);
  drawStreak(streak, days, series);

  const rows = days.slice().reverse().map((k, i) => {
    const tr = document.createElement('tr');
    [prettyDate(k), resultText(entries[k]), series[days.length - 1 - i]].forEach(v => {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    });
    return tr;
  });
  $('#chart-table').replaceChildren(...rows);
}

function drawDaily(box, days) {
  const W = box.clientWidth, H = 200;
  const m = { t: 12, r: 4, b: 26, l: 30 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const maxX = Math.max(1, ...days.map(k => (entries[k] && !entries[k].kept ? entries[k].count : 0)));
  const y = v => m.t + ((1 - v) / (1 + maxX)) * ph; // +1 at the top, −maxX at the bottom
  const band = pw / days.length;
  const bw = Math.max(2, Math.min(24, band - 2));
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': 'Daily results chart' });

  const ticks = [1, 0, -maxX];
  if (maxX >= 4) ticks.push(-Math.round(maxX / 2));
  for (const t of ticks) {
    svg.appendChild(svgEl('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: t === 0 ? 'axis' : 'grid' }));
    addTick(svg, m.l - 6, y(t) + 3.5, t > 0 ? '+1' : t === 0 ? '0' : `−${-t}`);
  }

  days.forEach((k, i) => {
    const e = entries[k];
    const cx = m.l + band * i + band / 2;
    const hit = svgEl('rect', { x: m.l + band * i, y: m.t, width: band, height: ph, class: 'hit', tabindex: 0 });
    svg.appendChild(hit);
    if (e) svg.appendChild(svgEl('path', { d: barPath(cx - bw / 2, y(0), bw, y(e.kept ? 1 : -e.count)), class: e.kept ? 'bar-good' : 'bar-bad' }));
    else svg.appendChild(svgEl('circle', { cx, cy: y(0), r: 2, class: 'bar-none' }));

    const value = resultText(e);
    const label = prettyDate(k) + (e?.locked ? ' · locked' : '');
    hit.setAttribute('aria-label', `${label}: ${value}`);
    const show = () => {
      svg.querySelectorAll('.hit.on').forEach(h => h.classList.remove('on'));
      hit.classList.add('on');
      showTip(box, cx, e?.kept ? y(1) : y(0), value, label);
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('focus', show);
    hit.addEventListener('blur', () => { hit.classList.remove('on'); hideTip(box); });
  });

  addDateLabels(svg, days, i => m.l + band * i + band / 2, H - 6, m.l, W - m.r);
  svg.addEventListener('pointerleave', () => {
    svg.querySelectorAll('.hit.on').forEach(h => h.classList.remove('on'));
    hideTip(box);
  });
  box.replaceChildren(svg);
}

function drawStreak(box, days, series) {
  const W = box.clientWidth, H = 180;
  const m = { t: 16, r: 58, b: 26, l: 30 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const top = Math.max(3, ...series);
  const n = days.length;
  const x = i => (n === 1 ? m.l + pw / 2 : m.l + (i * pw) / (n - 1));
  const y = v => m.t + (1 - v / top) * ph;
  const svg = svgEl('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': 'Streak over time chart' });

  for (const t of [0, top]) {
    svg.appendChild(svgEl('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: t === 0 ? 'axis' : 'grid' }));
    addTick(svg, m.l - 6, y(t) + 3.5, String(t));
  }

  const pts = series.map((v, i) => `${x(i)},${y(v)}`);
  svg.appendChild(svgEl('path', { d: `M${x(0)},${y(0)} L${pts.join(' L')} L${x(n - 1)},${y(0)} Z`, class: 'area' }));
  svg.appendChild(svgEl('path', { d: `M${pts.join(' L')}`, class: 'line' }));
  svg.appendChild(svgEl('circle', { cx: x(n - 1), cy: y(series[n - 1]), r: 4, class: 'end-dot' }));
  const last = series[n - 1];
  const end = svgEl('text', { x: x(n - 1) + 9, y: y(last) + 4, class: 'end-label' });
  end.textContent = `${last} day${last === 1 ? '' : 's'}`;
  svg.appendChild(end);

  // Crosshair snaps to the nearest day
  const cross = svgEl('line', { y1: m.t, y2: m.t + ph, class: 'crosshair', visibility: 'hidden' });
  const dot = svgEl('circle', { r: 4, class: 'hover-dot', visibility: 'hidden' });
  const overlay = svgEl('rect', { x: m.l - 6, y: m.t, width: pw + 12, height: ph, class: 'overlay', tabindex: 0, 'aria-label': 'Streak by day. Use the arrow keys to move between days.' });
  svg.append(cross, dot, overlay);
  let current = n - 1;
  const showAt = i => {
    current = Math.max(0, Math.min(n - 1, i));
    const cx = x(current), cy = y(series[current]);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('visibility', 'visible');
    const v = series[current];
    showTip(box, cx, cy, `${v}-day streak`, `${prettyDate(days[current])} · ${resultText(entries[days[current]])}`);
  };
  const hide = () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); hideTip(box); };
  overlay.addEventListener('pointermove', e => {
    const px = e.clientX - svg.getBoundingClientRect().left;
    showAt(n === 1 ? 0 : Math.round(((px - m.l) / pw) * (n - 1)));
  });
  overlay.addEventListener('pointerleave', hide);
  overlay.addEventListener('focus', () => showAt(current));
  overlay.addEventListener('blur', hide);
  overlay.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); showAt(current - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); showAt(current + 1); }
  });

  addDateLabels(svg, days, x, H - 6, m.l, W - m.r);
  box.replaceChildren(svg);
}

let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if ($('#view-calendar').classList.contains('active')) drawCharts();
  }, 150);
});

// ---------- Start ----------
(async function init() {
  try {
    const s = await api('/api/session');
    if (s.loggedIn) return afterLogin(s);
  } catch {}
  showView('login');
})();
