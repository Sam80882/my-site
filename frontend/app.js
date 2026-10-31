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
function showView(name, fromHistory = false) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(`#view-${name}`).classList.add('active');
  scrollTo(0, 0);
  if (name === 'hub') renderHub();
  if (name === 'today') renderUpdate();
  if (name === 'calendar') renderCalendar();

  // Record the page so the browser / phone back button can return to it
  if (!fromHistory) {
    const state = { view: name, target: targetKey };
    const same = history.state && history.state.view === name;
    if (name === 'login' || name === 'welcome' || same) history.replaceState(state, '');
    else history.pushState(state, '');
  }
}

addEventListener('popstate', e => {
  if (momentClose) momentClose();
  if (!$('#intro').hidden) finishHubIntro(introRun, true);
  if (!username) return showView('login', true);
  const s = e.state;
  const view = s && s.view && s.view !== 'login' ? s.view : 'hub';
  if (view === 'today') targetKey = s.target || todayKey();
  showView(view, true);
});

// Ink bars drop over the page with a word, then lift away to reveal the next view
function shutterTo(name, word, onShown) {
  const shutter = $('#shutter');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  $('#shutter-word').textContent = word;
  shutter.className = 'shutter closing';
  setTimeout(() => {
    showView(name);
    if (onShown) onShown();
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
    // The login card flips away before the welcome screen spins in
    if (!reducedMotion()) {
      form.animate(
        [{ transform: 'none', opacity: 1 }, { transform: 'perspective(900px) rotateY(-85deg) scale(0.85)', opacity: 0 }],
        { duration: 550, easing: 'cubic-bezier(.7,0,.2,1)' }
      );
      await wait(550);
    }
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
  spinInWelcome();
}

async function logout() {
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  entries = {};
  username = '';
  showView('login');
}

$('#get-started').addEventListener('click', () => shutterTo('hub', 'Let’s begin.', playHubIntro));

// ---------- Intros ----------
function reducedMotion() {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const rand = (min, max) => min + Math.random() * (max - min);
const wait = ms => new Promise(r => setTimeout(r, ms));

// Wrap each character in a span so letters can move on their own
function splitLetters(el) {
  if (!el.dataset.split) {
    const walk = node => {
      [...node.childNodes].forEach(c => {
        if (c.nodeType === Node.TEXT_NODE) {
          const frag = document.createDocumentFragment();
          for (const ch of c.textContent) {
            if (ch === ' ') { frag.appendChild(document.createTextNode(' ')); continue; }
            const s = document.createElement('span');
            s.className = 'ch';
            s.textContent = ch;
            frag.appendChild(s);
          }
          c.replaceWith(frag);
        } else if (c.nodeType === Node.ELEMENT_NODE && c.tagName !== 'BR') {
          walk(c);
        }
      });
    };
    walk(el);
    el.dataset.split = '1';
  }
  return [...el.querySelectorAll('.ch')];
}

// Every letter tumbles in from a random spot in 3D space and lands in place
function spinInWelcome() {
  if (reducedMotion()) return;
  const view = $('#view-welcome');
  splitLetters(view.querySelector('.mega')).forEach((s, i) => {
    s.animate([
      { transform: `translate3d(${rand(-300, 300)}px, ${rand(-220, 220)}px, -700px) rotateX(${rand(-360, 360)}deg) rotateY(${rand(-360, 360)}deg) rotateZ(${rand(-180, 180)}deg) scale(0.3)`, opacity: 0 },
      { transform: 'none', opacity: 1 }
    ], { duration: 1200, delay: 150 + i * 45, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' });
  });
  view.querySelector('.label').animate(
    [{ transform: 'rotateX(90deg)', opacity: 0 }, { transform: 'none', opacity: 1 }],
    { duration: 700, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' }
  );
  view.querySelector('.welcome-foot .lede').animate(
    [{ transform: 'rotateY(70deg) translateX(-40px)', opacity: 0 }, { transform: 'none', opacity: 1 }],
    { duration: 900, delay: 900, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' }
  );
  $('#get-started').animate(
    [{ transform: 'rotate(-540deg) scale(0)', opacity: 0 }, { transform: 'none', opacity: 1 }],
    { duration: 1300, delay: 1000, easing: 'cubic-bezier(.2,.9,.25,1.15)', fill: 'backwards' }
  );
}

let introRun = 0;

// Calendar time-lapse, then today's clock; each scene shrinks into its menu row
async function playHubIntro() {
  if (reducedMotion()) return;
  const run = ++introRun;
  const alive = () => run === introRun;
  const hub = $('#view-hub');
  const todayRow = hub.querySelector('.row-today');
  const calRow = hub.querySelector('.row-cal');
  const intro = $('#intro');

  hub.classList.remove('intro-reveal');
  hub.classList.add('intro-pending');
  todayRow.classList.add('awaiting');
  calRow.classList.add('awaiting');
  intro.hidden = false;
  $('#intro-skip').onclick = () => finishHubIntro(run, true);

  await wait(500); // let the shutter lift
  if (!alive()) return;
  await calendarScene(alive);
  if (!alive()) return;
  await flyInto($('#scene-cal'), calRow);
  if (!alive()) return;
  await todayScene(alive);
  if (!alive()) return;
  await flyInto($('#scene-today'), todayRow);
  if (!alive()) return;
  finishHubIntro(run, false);
}

function finishHubIntro(run, skipped) {
  if (run !== introRun) return;
  introRun++;
  const hub = $('#view-hub');
  $('#intro').hidden = true;
  document.querySelectorAll('#intro .scene').forEach(s => {
    s.getAnimations({ subtree: true }).forEach(a => a.cancel());
    s.style.opacity = '';
  });
  hub.querySelectorAll('.index-row').forEach(r => r.classList.remove('awaiting'));
  hub.classList.remove('intro-pending');
  hub.classList.add('intro-reveal');
  if (skipped) hub.classList.remove('intro-reveal');
}

async function calendarScene(alive) {
  const scene = $('#scene-cal');
  const ring = $('#date-ring');
  const today = new Date();
  const days = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const radius = 150;
  ring.replaceChildren(...Array.from({ length: days }, (_, i) => {
    const s = document.createElement('span');
    const k = dateKey(new Date(today.getFullYear(), today.getMonth(), i + 1));
    s.textContent = i + 1;
    if (k === todayKey()) s.className = 'now';
    else if (entries[k]) s.className = entries[k].kept ? 'kept' : 'bad';
    s.style.transform = `rotateY(${(i * 360) / days}deg) translateZ(${radius}px)`;
    return s;
  }));

  scene.style.opacity = 1;
  scene.animate([{ opacity: 0, transform: 'translateY(30px)' }, { opacity: 1, transform: 'none' }], { duration: 450, easing: 'ease-out' });
  ring.animate(
    [{ transform: 'rotateX(-16deg) rotateY(0deg)' }, { transform: `rotateX(-16deg) rotateY(${-720 - ((today.getDate() - 1) * 360) / days}deg)` }],
    { duration: 2100, easing: 'cubic-bezier(.15,.65,.2,1)', fill: 'forwards' }
  );

  // Date and clock race from the first of the month up to right now
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  const spanDays = today.getDate() - 1;
  const nowMin = today.getHours() * 60 + today.getMinutes();
  const start = performance.now();
  const duration = 1900;
  await new Promise(resolve => {
    setTimeout(resolve, duration + 100); // never wait on frames alone
    const tick = () => {
      if (!alive()) return resolve();
      const p = Math.min(1, (performance.now() - start) / duration);
      const e = 1 - Math.pow(1 - p, 3);
      const d = addDays(first, Math.round(e * spanDays));
      const mins = Math.round(e * ((spanDays * 1440) + nowMin)) % 1440;
      $('#scene-date').textContent = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
      $('#scene-time').textContent = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
      if (p < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  await wait(350);
}

async function todayScene(alive) {
  const scene = $('#scene-today');
  const face = $('#dial-face');
  if (!face.childElementCount) {
    for (let i = 0; i < 60; i++) {
      const major = i % 5 === 0;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', 100); line.setAttribute('x2', 100);
      line.setAttribute('y1', 8); line.setAttribute('y2', major ? 22 : 14);
      line.setAttribute('transform', `rotate(${i * 6} 100 100)`);
      if (major) line.setAttribute('class', 'major');
      face.appendChild(line);
    }
  }
  const now = new Date();
  $('#scene-today-date').textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) +
    ' · ' + now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  scene.style.opacity = 1;
  scene.animate([{ opacity: 0, transform: 'translateY(30px)' }, { opacity: 1, transform: 'none' }], { duration: 450, easing: 'ease-out' });
  scene.querySelector('.dial').animate([{ transform: 'scale(0.6) rotate(-90deg)' }, { transform: 'none' }], { duration: 700, easing: 'cubic-bezier(.2,.9,.25,1.15)' });
  scene.querySelector('.sunrise').animate([{ transform: 'translateY(90px)' }, { transform: 'none' }], { duration: 1600, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' });
  const minDeg = now.getMinutes() * 6;
  const hourDeg = (now.getHours() % 12) * 30 + now.getMinutes() * 0.5;
  $('#hand-m').animate([{ transform: 'rotate(0deg)' }, { transform: `rotate(${1440 + minDeg}deg)` }], { duration: 1700, easing: 'cubic-bezier(.15,.65,.2,1)', fill: 'forwards' });
  $('#hand-h').animate([{ transform: 'rotate(0deg)' }, { transform: `rotate(${360 + hourDeg}deg)` }], { duration: 1700, easing: 'cubic-bezier(.15,.65,.2,1)', fill: 'forwards' });
  // Timers rather than animation promises, so the sequence never stalls
  await wait(1700);
  if (alive()) await wait(350);
}

// Shrink a scene into the title of its menu row, then reveal the row
async function flyInto(scene, row) {
  const target = row.querySelector('.index-title').getBoundingClientRect();
  const text = scene.querySelector('.scene-big').getBoundingClientRect();
  const s = Math.min(1, target.height / text.height);
  const dx = target.left - text.left * s;
  const dy = target.top + target.height / 2 - (text.top + text.height / 2) * s;
  const fly = scene.animate(
    [{ transform: 'none', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(${s})`, opacity: 0 }],
    { duration: 700, easing: 'cubic-bezier(.7,0,.2,1)', fill: 'forwards' }
  );
  await wait(380);
  row.classList.remove('awaiting');
  row.animate([{ opacity: 0, transform: 'scale(0.96)', filter: 'blur(6px)' }, { opacity: 1, transform: 'none', filter: 'none' }], { duration: 600, easing: 'cubic-bezier(.2,.8,.2,1)' });
  await wait(330);
  scene.style.opacity = 0;
  fly.cancel();
}

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
  $('#done-art').innerHTML = artFor('closed');
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
$('#btn-no').addEventListener('click', async () => {
  await momentNo();
  showStep('#step-count');
  renderCount();
});
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
    if (body.kept) await momentYes(streakAt(targetKey));
    else await momentSlip(body.count);
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
  const art = $('#done-art');
  if (justSaved && !entry.locked) {
    // Right after saving: applause for "Nicely done", tears for "Tomorrow is a fresh page"
    art.innerHTML = entry.kept ? '<div class="art-halo" style="background:var(--amber)"></div>' : '';
    const gif = gifFigure(entry.kept ? CLAP_GIF : CRY_GIF);
    gif.classList.add('art-pop');
    if (!entry.kept) gif.classList.add('sad-gif');
    art.appendChild(gif);
  } else {
    art.innerHTML = artFor(justLocked ? 'locked' : entry.kept ? 'kept' : entry.count >= 2 ? 'worse' : 'bad');
  }

  showStep('#step-done');
  restartStamp(stamp);
}

// Green days in a row ending on a given day
function streakAt(k) {
  let n = 0;
  for (let d = parseKey(k); entries[dateKey(d)]?.kept; d = addDays(d, -1)) n++;
  return n;
}

// ---------- Result illustrations (line art, drawn in SVG) ----------
function artFor(kind) {
  const sparkle = (x, y, s) => `<path class="art-twinkle" d="M${x} ${y - s}L${x + s * 0.3} ${y - s * 0.3}L${x + s} ${y}L${x + s * 0.3} ${y + s * 0.3}L${x} ${y + s}L${x - s * 0.3} ${y + s * 0.3}L${x - s} ${y}L${x - s * 0.3} ${y - s * 0.3}Z" fill="#ffc25c" stroke="none"/>`;
  const rays = n => Array.from({ length: n }, (_, i) => {
    const a = (i * 2 * Math.PI) / n;
    return `<line x1="${160 + Math.cos(a) * 120}" y1="${160 + Math.sin(a) * 120}" x2="${160 + Math.cos(a) * 150}" y2="${160 + Math.sin(a) * 150}"/>`;
  }).join('');
  const rain = (x0, x1, y, color) => `<g class="art-rain" stroke="${color}" stroke-width="3">${
    Array.from({ length: Math.floor((x1 - x0) / 18) + 1 }, (_, i) => `<line x1="${x0 + i * 18}" y1="${y}" x2="${x0 + i * 18 - 4}" y2="${y + 14}"/>`).join('')
  }</g>`;
  const cloud = (fill, stroke) => `<path d="M88 150h144a36 36 0 0 0 0-72 52 52 0 0 0-100 8 34 34 0 0 0-44 64z" fill="${fill}" stroke="${stroke}" stroke-width="4"/>`;

  if (kind === 'kept') return `
    <div class="art-halo" style="background:var(--amber)"></div>
    <svg viewBox="0 0 320 320" class="art-pop">
      <defs><linearGradient id="art-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffc25c"/><stop offset="1" stop-color="#ff6fb5"/></linearGradient></defs>
      <g class="art-spin" stroke="rgba(255,194,92,.28)" stroke-width="3">${rays(16)}</g>
      <g stroke="url(#art-gold)" stroke-width="5" fill="rgba(255,194,92,.08)">
        <path d="M112 92h96v38a48 48 0 0 1-96 0z"/>
        <path d="M112 104H90a22 22 0 0 0 26 38M208 104h22a22 22 0 0 1-26 38" fill="none"/>
        <path d="M160 178v30M130 234h60v-14a8 8 0 0 0-8-8h-44a8 8 0 0 0-8 8z"/>
      </g>
      <path d="M160 108l6 13 14 2-10 10 2 14-12-7-12 7 2-14-10-10 14-2z" fill="#ffc25c" stroke="none"/>
      <g stroke="#3a9a6b" stroke-width="4" fill="rgba(58,154,107,.18)">
        <path d="M96 226c-26-18-34-52-22-80" fill="none"/><path d="M224 226c26-18 34-52 22-80" fill="none"/>
        <ellipse cx="74" cy="176" rx="7" ry="13" transform="rotate(-25 74 176)"/><ellipse cx="80" cy="204" rx="7" ry="13" transform="rotate(-45 80 204)"/>
        <ellipse cx="246" cy="176" rx="7" ry="13" transform="rotate(25 246 176)"/><ellipse cx="240" cy="204" rx="7" ry="13" transform="rotate(45 240 204)"/>
      </g>
      ${sparkle(70, 80, 12)}${sparkle(256, 92, 9)}${sparkle(238, 262, 11)}${sparkle(84, 262, 8)}
    </svg>`;

  if (kind === 'bad') return `
    <div class="art-halo" style="background:#7fb6ff;opacity:.18"></div>
    <svg viewBox="0 0 320 320" class="art-pop">
      ${cloud('#1c1c22', '#8f8b98')}
      ${rain(104, 216, 170, '#7fb6ff')}
      <path d="M70 264h180" stroke="rgba(242,239,232,.2)" stroke-width="3"/>
      <g class="art-sprout" stroke="#3a9a6b" stroke-width="4" fill="rgba(58,154,107,.25)">
        <path d="M160 264v-44" fill="none"/>
        <path d="M160 236c-26-4-36-22-36-34 18 0 34 12 36 34z"/>
        <path d="M160 226c22-6 32-22 32-34-16 0-30 12-32 34z"/>
      </g>
    </svg>`;

  if (kind === 'worse') return `
    <div class="art-halo" style="background:#d4513c;opacity:.18"></div>
    <svg viewBox="0 0 320 320" class="art-pop">
      ${cloud('#141418', '#6b6878')}
      <path class="art-bolt" d="M168 150l-24 46h22l-14 46 40-60h-24l14-32z" fill="#ffc25c" stroke="none"/>
      ${rain(96, 140, 168, '#7fb6ff')}${rain(196, 232, 168, '#7fb6ff')}
      <path d="M70 264h180" stroke="rgba(242,239,232,.2)" stroke-width="3"/>
    </svg>`;

  if (kind === 'locked') return `
    <div class="art-halo" style="background:var(--violet)"></div>
    <svg viewBox="0 0 320 320" class="art-pop">
      <g class="art-spin" stroke="rgba(165,148,255,.25)" stroke-width="3">${rays(12)}</g>
      <path class="art-shackle" d="M122 150v-30a38 38 0 0 1 76 0v30" stroke="#f2efe8" stroke-width="10"/>
      <rect x="98" y="148" width="124" height="104" rx="16" fill="rgba(165,148,255,.12)" stroke="#a594ff" stroke-width="5"/>
      <circle cx="160" cy="190" r="12" fill="#e0352b"/><path d="M160 198v24" stroke="#e0352b" stroke-width="8"/>
      ${sparkle(250, 110, 10)}${sparkle(74, 214, 8)}
    </svg>`;

  return `
    <svg viewBox="0 0 320 320" class="art-pop">
      <g stroke="#8f8b98" stroke-width="5">
        <path d="M110 80h100M110 240h100"/>
        <path d="M120 80c0 50 80 50 80 80s-80 30-80 80M200 80c0 50-80 50-80 80s80 30 80 80" fill="rgba(242,239,232,.04)"/>
      </g>
      <path d="M136 226h48l-24-26z" fill="#ffc25c" stroke="none"/>
    </svg>`;
}

// ---------- Moments after answering ----------
let momentClose = null;

// Show the overlay until it's tapped or the time runs out
function holdMoment(ms) {
  const m = $('#moment');
  m.hidden = false;
  return new Promise(resolve => {
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      m.onclick = null;
      momentClose = null;
      m.hidden = true;
      resolve();
    };
    m.onclick = end;
    momentClose = end;
    setTimeout(end, ms);
  });
}

function fadeUp(els, start) {
  els.forEach((el, i) => el.animate(
    [{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'none' }],
    { duration: 600, delay: start + i * 120, easing: 'ease-out', fill: 'backwards' }
  ));
}

function burstConfetti() {
  const colors = ['#a594ff', '#ff6fb5', '#ffc25c', '#4fd1b8', '#3a9a6b'];
  for (let i = 0; i < 90; i++) {
    const bit = document.createElement('i');
    bit.className = 'confetti-bit';
    bit.style.background = colors[i % colors.length];
    document.body.appendChild(bit);
    const a = rand(0, Math.PI * 2), d = rand(140, 460);
    bit.animate([
      { transform: 'translate(-50%, -50%) rotate(0deg)', opacity: 1 },
      { transform: `translate(calc(-50% + ${Math.cos(a) * d}px), calc(-50% + ${Math.sin(a) * d + 180}px)) rotate(${rand(-720, 720)}deg)`, opacity: 0 }
    ], { duration: rand(1200, 2000), easing: 'cubic-bezier(.1,.7,.3,1)', fill: 'forwards' });
    setTimeout(() => bit.remove(), 2100);
  }
}

// GIFs for the moments, served by Giphy (the video versions are far lighter than the .gif files)
const giphy = (id, alt, ratio, width) => ({
  video: `https://media.giphy.com/media/${id}/giphy.mp4`,
  still: `https://media.giphy.com/media/${id}/giphy_s.gif`,
  alt,
  ratio,
  width
});
const CLAP_GIF = giphy('fDbzXb6Cv5L56', 'Applause', '1 / 1', '100%');
const CRY_GIF = giphy('4vQyO4VgU8XngKKhDx', 'Crying', '470 / 480', '100%');
const SAD_GIF = giphy('78EYl1VZVA9KE', 'A sad, teary face', '289 / 283', 'min(320px, 76vw)');
const CHEER_GIF = giphy('11sBLVxNs7v6WA', 'Minions cheering', '500 / 226');
const FACEPALM_GIF = giphy('58FqDYgcQhrdSj5oUJ', 'A facepalm', '480 / 260');
const THROW_GIF = giphy('FXGoDrsgrNLj2', 'Throwing a computer in frustration', '500 / 281');

function gifFigure(gif) {
  const fig = document.createElement('figure');
  fig.className = 'moment-gif';
  let media;
  if (reducedMotion()) {
    media = document.createElement('img');
    media.src = gif.still;
    media.alt = gif.alt;
  } else {
    media = document.createElement('video');
    // Muted before the source is set, so phones allow autoplay
    Object.assign(media, { muted: true, autoplay: true, loop: true, playsInline: true, poster: gif.still });
    media.src = gif.video;
    media.setAttribute('aria-label', gif.alt);
  }
  media.style.aspectRatio = gif.ratio;
  if (gif.width) fig.style.width = gif.width;
  media.addEventListener('error', () => fig.remove()); // offline or blocked: just skip it
  const credit = document.createElement('figcaption');
  credit.textContent = 'via GIPHY';
  fig.append(media, credit);
  return fig;
}

const MILESTONES = { 3: 'Three in a row!', 7: 'One full week!', 14: 'Two weeks strong!', 21: '21 days — a habit is forming!', 30: 'A whole month!', 50: 'Fifty days!', 100: 'One hundred days!' };

// Yes: a medal drops in, spins, and the streak ticks up with confetti
async function momentYes(n) {
  const m = $('#moment');
  const stage = $('#moment-stage');
  m.classList.remove('sad');
  const milestone = MILESTONES[n];
  stage.innerHTML = `
    <div class="medal"><div class="medal-rays"></div><div class="medal-coin" id="medal-num">${Math.max(0, n - 1)}</div></div>
    <p class="moment-kicker">Achievement unlocked</p>
    <h2 class="moment-title">Day ${n} <em>streak</em></h2>
    ${milestone ? `<p class="moment-milestone">${milestone}</p>` : ''}
    <p class="moment-sub">${n === 1 ? 'Every streak starts with day one. You just started yours.' : 'You showed up again. Keep the chain going.'}</p>`;
  stage.querySelector('.moment-title').after(gifFigure(CHEER_GIF));
  const shown = holdMoment(5000);
  if (reducedMotion()) {
    $('#medal-num').textContent = n;
  } else {
    stage.querySelector('.medal-coin').animate(
      [{ transform: 'translateY(-260px) rotateY(0deg) scale(0.4)', opacity: 0 }, { transform: 'none', opacity: 1 }],
      { duration: 1100, easing: 'cubic-bezier(.2,.9,.25,1.1)' }
    );
    fadeUp([...stage.querySelectorAll('.moment-kicker, .moment-title, .moment-milestone, .moment-sub')], 700);
    stage.querySelector('.moment-gif')?.animate(
      [{ opacity: 0, transform: 'scale(0.6) rotate(-6deg)' }, { opacity: 1, transform: 'none' }],
      { duration: 700, delay: 1000, easing: 'cubic-bezier(.2,1.4,.4,1)', fill: 'backwards' }
    );
    setTimeout(() => {
      const num = $('#medal-num');
      if (!num) return;
      num.textContent = n;
      num.animate([{ transform: 'scale(1.6)' }, { transform: 'none' }], { duration: 500, easing: 'cubic-bezier(.2,1.4,.4,1)' });
      burstConfetti();
    }, 950);
  }
  await shown;
}

// Saved as broken: a facepalm for one X, a thrown computer for two or more, then on to the result
async function momentSlip(count) {
  const m = $('#moment');
  const stage = $('#moment-stage');
  m.classList.add('sad');
  const once = count === 1;
  stage.innerHTML = once ? `
    <p class="moment-kicker">One X today</p>
    <h2 class="moment-title">Just <em>once.</em></h2>
    <p class="moment-sub">So close. One slip doesn’t define you — tomorrow you go again.</p>` : `
    <p class="moment-kicker">${marksOf({ kept: false, count })} today</p>
    <h2 class="moment-title">Rough <em>day.</em></h2>
    <p class="moment-sub">${count} slips — frustrating, we know. Let it out, reset, and tomorrow is a clean page.</p>`;
  stage.querySelector('.moment-title').after(gifFigure(once ? FACEPALM_GIF : THROW_GIF));
  document.body.classList.add('drained');
  const shown = holdMoment(4500);
  if (!reducedMotion()) {
    fadeUp([...stage.querySelectorAll('.moment-kicker, .moment-title, .moment-sub')], 150);
    stage.querySelector('.moment-gif')?.animate(
      [{ opacity: 0, transform: 'translateY(30px) scale(0.9)' }, { opacity: 1, transform: 'none' }],
      { duration: 700, delay: 350, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' }
    );
  }
  await shown;
  document.body.classList.remove('drained');
}

// No: colour drains away and a sad little rain cloud drifts in
async function momentNo() {
  const m = $('#moment');
  const stage = $('#moment-stage');
  m.classList.add('sad');
  stage.innerHTML = `
    <p class="moment-kicker">Streak interrupted</p>
    <h2 class="moment-title">Oh no… <em>that’s okay.</em></h2>
    <p class="moment-sub">A slip isn’t the end. Be honest about how many times, and tomorrow is a fresh page.</p>`;
  stage.prepend(gifFigure(SAD_GIF));
  document.body.classList.add('drained');
  const shown = holdMoment(4000);
  if (!reducedMotion()) {
    stage.querySelector('.moment-gif')?.animate(
      [{ transform: 'translateY(-40px) rotate(-4deg)', opacity: 0 }, { transform: 'none', opacity: 1 }],
      { duration: 900, easing: 'cubic-bezier(.2,.8,.2,1)' }
    );
    fadeUp([...stage.querySelectorAll('.moment-kicker, .moment-title, .moment-sub')], 500);
  }
  await shown;
  document.body.classList.remove('drained');
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
