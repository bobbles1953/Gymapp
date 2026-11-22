import * as db from './db.js';
import {
  convert, toKg, byNewest, groupByExercise, personalBests, newRecords,
  topSet, volumeKg, parseBackup,
} from './stats.js';

const $ = (sel, root = document) => root.querySelector(sel);
const DAY = 24 * 60 * 60 * 1000;
const ROUTES = {
  log: 'Log a workout',
  history: 'History',
  bests: 'Personal bests',
  backup: 'Backup and settings',
};

const state = {
  workouts: [],
  unit: 'kg',
  reminderDays: 7,
  lastBackup: null,      // ISO string
  snoozedUntil: null,    // ISO string
  historyKey: null,
};

const makeId = () => (crypto.randomUUID ? crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

// ---------- Formatting ----------

const numFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function fmtWeight(weight, fromUnit) {
  return `${numFmt.format(convert(weight, fromUnit, state.unit))} ${state.unit}`;
}
const fmtKg = (kg) => fmtWeight(kg, 'kg');

function parseLocalDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
const fmtDate = (iso) => dateFmt.format(parseLocalDate(iso));

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function describeSets(w) {
  // Collapse identical consecutive sets: "3 × 8 @ 60 kg, 1 × 6 @ 65 kg"
  const parts = [];
  for (const s of w.sets) {
    const last = parts[parts.length - 1];
    if (last && last.reps === s.reps && last.weight === s.weight) last.count++;
    else parts.push({ ...s, count: 1 });
  }
  return parts.map((p) => {
    const load = p.weight > 0 ? ` @ ${fmtWeight(p.weight, w.unit)}` : ' (bodyweight)';
    return `${p.count} × ${p.reps}${load}`;
  }).join(', ');
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

function announce(msg) {
  const a = $('#announcer');
  a.textContent = '';
  // Next frame so repeated identical messages are still announced.
  requestAnimationFrame(() => { a.textContent = msg; });
}

// ---------- Confirm dialog ----------

function confirmDialog({ title, message, confirmLabel }) {
  const dlg = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-message').textContent = message;
  $('#confirm-ok').textContent = confirmLabel;
  const opener = document.activeElement;
  return new Promise((resolve) => {
    dlg.returnValue = 'cancel';
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'confirm');
      if (opener && opener.isConnected) opener.focus();
    }, { once: true });
    dlg.showModal();
    $('#confirm-cancel').focus(); // safe default for destructive actions
  });
}

// ---------- Routing ----------

function currentRoute() {
  const r = location.hash.slice(1);
  return r in ROUTES ? r : 'log';
}

function showRoute({ focus }) {
  const route = currentRoute();
  for (const section of document.querySelectorAll('[data-view]')) {
    section.hidden = section.dataset.view !== route;
  }
  for (const a of document.querySelectorAll('[data-route]')) {
    if (a.dataset.route === route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.title = `${ROUTES[route]} – Gym Log`;
  render(route);
  if (focus) $(`#${route}-heading`).focus();
}

function render(route = currentRoute()) {
  renderExerciseList();
  if (route === 'log') renderRecent();
  if (route === 'history') renderHistory();
  if (route === 'bests') renderBests();
  if (route === 'backup') renderBackup();
  renderReminder();
}

// ---------- Log form ----------

const setRows = () => [...document.querySelectorAll('#set-rows .set-row')];
let rowSeq = 0;

function addSetRow(values = {}) {
  const tpl = $('#set-row-template').content.firstElementChild.cloneNode(true);
  const n = ++rowSeq;
  for (const input of tpl.querySelectorAll('input')) {
    const name = input.dataset.name;
    input.id = `set-${n}-${name}`;
    input.name = `${name}-${n}`;
    tpl.querySelector(`label[data-for="${name}"]`).htmlFor = input.id;
    if (values[name] != null) input.value = values[name];
  }
  const err = tpl.querySelector('.field-error');
  err.id = `set-${n}-error`;
  const label = tpl.querySelector('.set-label');
  label.id = `set-${n}-label`;
  tpl.setAttribute('aria-labelledby', label.id);
  tpl.querySelector('.remove-set').addEventListener('click', () => removeSetRow(tpl));
  $('#set-rows').append(tpl);
  renumberSets();
  return tpl;
}

function removeSetRow(row) {
  const rows = setRows();
  const idx = rows.indexOf(row);
  row.remove();
  renumberSets();
  const remaining = setRows();
  const target = remaining[Math.min(idx, remaining.length - 1)];
  (target ? target.querySelector('input') : $('#add-set')).focus();
  announce(`Set ${idx + 1} removed. ${remaining.length} ${remaining.length === 1 ? 'set' : 'sets'} left.`);
}

function renumberSets() {
  const rows = setRows();
  rows.forEach((row, i) => {
    row.querySelector('.set-label').textContent = `Set ${i + 1}`;
    const btn = row.querySelector('.remove-set');
    btn.textContent = '';
    btn.append('Remove', el('span', { class: 'visually-hidden', text: ` set ${i + 1}` }));
    btn.hidden = rows.length === 1;
  });
}

function updateUnitLabels() {
  for (const n of document.querySelectorAll('[data-unit-label]')) n.textContent = state.unit;
}

function resetLogForm({ keepExercise = false } = {}) {
  const ex = $('#f-exercise').value;
  $('#log-form').reset();
  $('#f-date').value = todayISO();
  if (keepExercise) $('#f-exercise').value = ex;
  $('#set-rows').replaceChildren();
  addSetRow();
  clearLogErrors();
}

function setFieldError(input, errorEl, message) {
  if (message) {
    input.setAttribute('aria-invalid', 'true');
    errorEl.textContent = message;
    errorEl.hidden = false;
  } else {
    input.removeAttribute('aria-invalid');
    errorEl.textContent = '';
    errorEl.hidden = true;
  }
}

function clearLogErrors() {
  $('#log-errors').hidden = true;
  for (const input of document.querySelectorAll('#log-form [aria-invalid]')) input.removeAttribute('aria-invalid');
  for (const e of document.querySelectorAll('#log-form .field-error')) { e.hidden = true; e.textContent = ''; }
  for (const input of document.querySelectorAll('#set-rows input')) input.removeAttribute('aria-describedby');
}

function validateLogForm() {
  clearLogErrors();
  const errors = []; // { input, message }
  const date = $('#f-date');
  if (!date.value) {
    errors.push({ input: date, message: 'Enter the date of the workout.' });
  } else if (date.value > todayISO()) {
    errors.push({ input: date, message: 'The date cannot be in the future.' });
  }
  setFieldError(date, $('#f-date-error'), errors.find((e) => e.input === date)?.message);

  const exercise = $('#f-exercise');
  const exName = exercise.value.trim().replace(/\s+/g, ' ');
  if (!exName) {
    errors.push({ input: exercise, message: 'Enter the name of the exercise.' });
    setFieldError(exercise, $('#f-exercise-error'), 'Enter the name of the exercise.');
  }

  const sets = [];
  setRows().forEach((row, i) => {
    const repsIn = row.querySelector('[data-name="reps"]');
    const weightIn = row.querySelector('[data-name="weight"]');
    const err = row.querySelector('.field-error');
    const msgs = [];
    const reps = Number(repsIn.value);
    const weight = Number(weightIn.value);
    if (repsIn.value === '' || !Number.isInteger(reps) || reps < 1 || reps > 1000) {
      const m = `Set ${i + 1}: enter reps as a whole number from 1 to 1000.`;
      msgs.push(m); errors.push({ input: repsIn, message: m });
      repsIn.setAttribute('aria-invalid', 'true');
      repsIn.setAttribute('aria-describedby', err.id);
    }
    if (weightIn.value === '' || !Number.isFinite(weight) || weight < 0 || weight > 2000) {
      const m = `Set ${i + 1}: enter weight as a number from 0 to 2000 (0 for bodyweight).`;
      msgs.push(m); errors.push({ input: weightIn, message: m });
      weightIn.setAttribute('aria-invalid', 'true');
      weightIn.setAttribute('aria-describedby', err.id);
    }
    if (msgs.length) { err.textContent = msgs.join(' '); err.hidden = false; }
    sets.push({ reps, weight });
  });

  if (errors.length) {
    const list = $('#log-error-list');
    list.replaceChildren(...errors.map((e) => el('li', {},
      el('a', { href: `#${e.input.id}`, text: e.message, onclick: (ev) => { ev.preventDefault(); e.input.focus(); } }))));
    const summary = $('#log-errors');
    summary.hidden = false;
    summary.focus();
    return null;
  }
  return { date: date.value, exercise: exName, sets, notes: $('#f-notes').value.trim() };
}

async function onSaveWorkout(ev) {
  ev.preventDefault();
  $('#log-result').hidden = true;
  const data = validateLogForm();
  if (!data) return;
  const key = db.exerciseKey(data.exercise);
  // Reuse the existing display name so "bench press" and "Bench Press" stay one exercise.
  const existing = state.workouts.find((w) => w.exerciseKey === key);
  const workout = {
    id: makeId(),
    date: data.date,
    exercise: existing ? existing.exercise : data.exercise,
    exerciseKey: key,
    unit: state.unit,
    sets: data.sets,
    notes: data.notes,
    createdAt: new Date().toISOString(),
  };
  const previous = state.workouts.filter((w) => w.exerciseKey === key);
  const result = $('#log-result');
  try {
    await db.putWorkout(workout);
  } catch (err) {
    result.className = 'result is-error';
    result.replaceChildren(el('p', { text: `Could not save: ${err.message || err}. Your entry is still in the form.` }));
    result.hidden = false;
    result.focus();
    return;
  }
  state.workouts.push(workout);
  requestPersistence(); // first real data is a good moment to ask

  const records = newRecords(previous, workout);
  const n = workout.sets.length;
  result.className = 'result';
  result.replaceChildren(
    el('p', { text: `Saved ${workout.exercise} on ${fmtDate(workout.date)}: ${n} ${n === 1 ? 'set' : 'sets'}.` }),
    ...(records.length ? [el('p', { class: 'pb-badge', text: `New personal best: ${records.join(', ')}!` })] : []),
  );
  result.hidden = false;
  resetLogForm({ keepExercise: false });
  render('log');
  result.focus();
}

function renderExerciseList() {
  const groups = groupByExercise(state.workouts);
  $('#exercise-list').replaceChildren(...groups.map((g) => el('option', { value: g.name })));
}

function deleteButton(w, label) {
  return el('button', {
    type: 'button', class: 'button-link',
    onclick: async () => {
      const ok = await confirmDialog({
        title: 'Delete this entry?',
        message: `${w.exercise} on ${fmtDate(w.date)} (${describeSets(w)}) will be permanently deleted.`,
        confirmLabel: 'Delete entry',
      });
      if (!ok) return;
      await db.deleteWorkout(w.id);
      state.workouts = state.workouts.filter((x) => x.id !== w.id);
      render();
      announce(`Deleted ${w.exercise} on ${fmtDate(w.date)}.`);
      $(`#${currentRoute()}-heading`).focus();
    },
  }, 'Delete', el('span', { class: 'visually-hidden', text: ` ${label}` }));
}

function renderRecent() {
  const recent = [...state.workouts].sort(byNewest).slice(0, 10);
  const box = $('#recent-list');
  if (!recent.length) {
    box.replaceChildren(el('p', { class: 'empty', text: 'No workouts logged yet.' }));
    return;
  }
  box.replaceChildren(workoutTable({
    caption: 'Your 10 most recent entries, newest first',
    rows: recent,
    showExercise: true,
  }));
}

function workoutTable({ caption, rows, showExercise }) {
  const head = el('tr', {},
    el('th', { scope: 'col', text: 'Date' }),
    showExercise ? el('th', { scope: 'col', text: 'Exercise' }) : null,
    el('th', { scope: 'col', text: 'Sets' }),
    el('th', { scope: 'col', class: 'num', text: 'Top set' }),
    el('th', { scope: 'col', class: 'num', text: 'Volume' }),
    el('th', { scope: 'col' }, el('span', { class: 'visually-hidden', text: 'Actions' })));
  const body = rows.map((w) => {
    const top = topSet(w);
    const label = `${w.exercise} on ${fmtDate(w.date)}`;
    return el('tr', {},
      el('th', { scope: 'row', text: fmtDate(w.date) }),
      showExercise ? el('td', { text: w.exercise }) : null,
      el('td', {}, describeSets(w), w.notes ? el('div', { class: 'hint', text: `Notes: ${w.notes}` }) : null),
      el('td', { class: 'num', text: top.weight > 0 ? `${top.reps} × ${fmtWeight(top.weight, w.unit)}` : `${top.reps} reps` }),
      el('td', { class: 'num', text: fmtKg(volumeKg(w)) }),
      el('td', {}, deleteButton(w, label)));
  });
  const capId = `cap-${makeId()}`;
  return el('div', { class: 'table-scroll', role: 'region', 'aria-labelledby': capId, tabindex: '0' },
    el('table', {}, el('caption', { id: capId, text: caption }), el('thead', {}, head), el('tbody', {}, body)));
}

// ---------- History ----------

function renderHistory() {
  const groups = groupByExercise(state.workouts);
  const select = $('#history-exercise');
  const box = $('#history-content');
  if (!groups.length) {
    select.replaceChildren(el('option', { value: '', text: 'No exercises yet' }));
    select.disabled = true;
    box.replaceChildren(el('p', { class: 'empty' }, 'Nothing here yet. ', el('a', { href: '#log', text: 'Log your first workout' }), '.'));
    return;
  }
  select.disabled = false;
  if (!groups.some((g) => g.key === state.historyKey)) state.historyKey = groups[0].key;
  select.replaceChildren(...groups.map((g) => el('option', {
    value: g.key, selected: g.key === state.historyKey, text: `${g.name} (${g.workouts.length})`,
  })));
  const g = groups.find((x) => x.key === state.historyKey);
  const pb = personalBests(g.workouts);
  const summary = el('ul', {},
    pb.heaviest ? el('li', { text: `Heaviest: ${fmtKg(pb.heaviest.valueKg)} × ${pb.heaviest.set.reps} (${fmtDate(pb.heaviest.workout.date)})` }) : null,
    pb.e1rm ? el('li', { text: `Best estimated one-rep max: ${fmtKg(pb.e1rm.valueKg)}` }) : null,
    el('li', { text: `Sessions logged: ${g.workouts.length}` }));
  box.replaceChildren(
    el('h2', { text: g.name }),
    summary,
    workoutTable({ caption: `${g.name} history, newest first`, rows: g.workouts, showExercise: false }));
}

// ---------- Bests ----------

function renderBests() {
  const groups = groupByExercise(state.workouts);
  const box = $('#bests-content');
  if (!groups.length) {
    box.replaceChildren(el('p', { class: 'empty' }, 'No personal bests yet. ', el('a', { href: '#log', text: 'Log a workout' }), ' to start.'));
    return;
  }
  const cell = (rec, text) => el('td', {}, rec ? [text, el('br'), el('span', { class: 'hint', text: fmtDate(rec.workout.date) })] : '–');
  const rows = groups.map((g) => {
    const pb = personalBests(g.workouts);
    return el('tr', {},
      el('th', { scope: 'row', text: g.name }),
      cell(pb.heaviest, pb.heaviest && `${fmtKg(pb.heaviest.valueKg)} × ${pb.heaviest.set.reps}`),
      cell(pb.e1rm, pb.e1rm && fmtKg(pb.e1rm.valueKg)),
      cell(pb.reps, pb.reps && `${pb.reps.reps} reps`),
      cell(pb.volume, pb.volume && fmtKg(pb.volume.valueKg)));
  });
  box.replaceChildren(el('div', { class: 'table-scroll', role: 'region', 'aria-labelledby': 'bests-caption', tabindex: '0' },
    el('table', {},
      el('caption', { id: 'bests-caption', text: 'Best result for each exercise, with the date it was set' }),
      el('thead', {}, el('tr', {},
        el('th', { scope: 'col', text: 'Exercise' }),
        el('th', { scope: 'col', text: 'Heaviest set' }),
        el('th', { scope: 'col', text: 'Est. one-rep max' }),
        el('th', { scope: 'col', text: 'Most reps' }),
        el('th', { scope: 'col', text: 'Session volume' }))),
      el('tbody', {}, rows))));
}

// ---------- Backup ----------

function daysSince(iso) {
  return Math.floor((Date.now() - Date.parse(iso)) / DAY);
}

function renderBackup() {
  const text = $('#last-backup-text');
  if (state.lastBackup) {
    const d = daysSince(state.lastBackup);
    const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(state.lastBackup));
    text.textContent = `Last backup: ${when} (${d === 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`}).`;
  } else {
    text.textContent = 'You have not exported a backup from this device yet.';
  }
  $('#setting-unit').value = state.unit;
  $('#setting-reminder').value = String(state.reminderDays);
  renderStorageStatus();
}

function renderReminder() {
  const banner = $('#backup-reminder');
  const due = state.reminderDays > 0 && state.workouts.length > 0 &&
    (!state.snoozedUntil || Date.now() > Date.parse(state.snoozedUntil)) &&
    (!state.lastBackup || daysSince(state.lastBackup) >= state.reminderDays);
  if (!due || currentRoute() === 'backup') { banner.hidden = true; return; }
  $('#backup-reminder-text').textContent = state.lastBackup
    ? `Your last backup was ${daysSince(state.lastBackup)} days ago. Export a backup so you don’t lose your workouts.`
    : 'You haven’t backed up your workouts yet. Data stored in a browser can be lost, so export a backup.';
  banner.hidden = false;
}

async function onExport() {
  const now = new Date().toISOString();
  const payload = {
    app: 'gymapp',
    version: 1,
    exportedAt: now,
    settings: { unit: state.unit, reminderDays: state.reminderDays },
    workouts: [...state.workouts].sort(byNewest),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `gym-log-backup-${todayISO()}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  state.lastBackup = now;
  await db.setMeta('lastBackup', now);
  renderBackup();
  renderReminder();
  announce(`Backup of ${state.workouts.length} ${state.workouts.length === 1 ? 'entry' : 'entries'} downloaded.`);
}

async function onImport(ev) {
  ev.preventDefault();
  const fileInput = $('#import-file');
  const errEl = $('#import-file-error');
  const result = $('#import-result');
  result.hidden = true;
  result.replaceChildren();
  setFieldError(fileInput, errEl, null);
  const file = fileInput.files[0];
  if (!file) {
    setFieldError(fileInput, errEl, 'Choose a backup file to import.');
    fileInput.focus();
    return;
  }
  const mode = document.querySelector('input[name="import-mode"]:checked').value;
  let parsed;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error('The file is larger than 20 MB.');
    parsed = parseBackup(await file.text(), makeId);
  } catch (err) {
    setFieldError(fileInput, errEl, err.message);
    fileInput.focus();
    return;
  }
  if (!parsed.workouts.length) {
    setFieldError(fileInput, errEl, 'The file contains no valid workouts.');
    fileInput.focus();
    return;
  }
  if (mode === 'replace' && state.workouts.length) {
    const ok = await confirmDialog({
      title: 'Replace all data?',
      message: `This deletes all ${state.workouts.length} entries on this device and replaces them with ${parsed.workouts.length} from the file.`,
      confirmLabel: 'Replace all data',
    });
    if (!ok) return;
  }
  try {
    await db.importWorkouts(parsed.workouts, mode);
  } catch (err) {
    result.className = 'result is-error';
    result.replaceChildren(el('p', { text: `Import failed: ${err.message || err}. No changes were made.` }));
    result.hidden = false;
    result.focus();
    return;
  }
  const s = parsed.settings;
  if (s && (s.unit === 'kg' || s.unit === 'lb') && !state.workouts.length) {
    state.unit = s.unit; await db.setMeta('unit', s.unit); updateUnitLabels();
  }
  state.workouts = await db.getAllWorkouts();
  // Data just came from a backup file, so it is backed up as of now.
  if (!state.lastBackup) { state.lastBackup = new Date().toISOString(); await db.setMeta('lastBackup', state.lastBackup); }
  fileInput.value = '';
  result.className = 'result';
  result.replaceChildren(
    el('p', { text: `Imported ${parsed.workouts.length} ${parsed.workouts.length === 1 ? 'entry' : 'entries'} (${mode === 'replace' ? 'replaced existing data' : 'merged'}).` }),
    ...(parsed.skipped ? [el('p', { text: `${parsed.skipped} invalid ${parsed.skipped === 1 ? 'entry was' : 'entries were'} skipped.` })] : []),
    el('p', { text: `You now have ${state.workouts.length} entries.` }));
  result.hidden = false;
  render('backup');
  result.focus();
  requestPersistence();
}

// ---------- Persistent storage ----------

async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    const granted = await navigator.storage.persist();
    if (currentRoute() === 'backup') renderStorageStatus();
    return granted;
  } catch { return false; }
}

async function renderStorageStatus() {
  const status = $('#storage-status');
  const btn = $('#persist-btn');
  if (!navigator.storage?.persisted) {
    status.textContent = 'This browser can’t guarantee your data is kept. Export backups regularly.';
    btn.hidden = true;
    return;
  }
  const persisted = await navigator.storage.persisted();
  let usage = '';
  try {
    const est = await navigator.storage.estimate();
    if (est.usage != null) usage = ` Gym Log is using about ${numFmt.format(est.usage / 1024)} KB.`;
  } catch { /* ignore */ }
  status.textContent = persisted
    ? `Persistent storage is on: the browser won’t clear your data to free up space.${usage}`
    : `Persistent storage is off: the browser may clear your data if the device runs low on space. Installing Gym Log to your home screen makes this more likely to be granted.${usage}`;
  btn.hidden = persisted;
}

// ---------- Service worker ----------

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Reload only when the user asked for an update; the very first install
  // also fires controllerchange (via clients.claim) and must not reload.
  let updateRequested = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateRequested) return;
    updateRequested = false;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offerUpdate = (worker) => {
      $('#update-banner').hidden = false;
      $('#apply-update').onclick = () => {
        updateRequested = true;
        worker.postMessage({ type: 'SKIP_WAITING' });
      };
    };
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w);
      });
    });
  }).catch(() => { /* offline support unavailable; app still works online */ });
}

// ---------- Init ----------

async function init() {
  try {
    const [workouts, unit, reminderDays, lastBackup, snoozedUntil] = await Promise.all([
      db.getAllWorkouts(), db.getMeta('unit', 'kg'), db.getMeta('reminderDays', 7),
      db.getMeta('lastBackup'), db.getMeta('snoozedUntil'),
    ]);
    Object.assign(state, { workouts, unit, reminderDays, lastBackup, snoozedUntil });
  } catch (err) {
    const main = $('#main');
    main.prepend(el('div', { class: 'result is-error', role: 'alert' },
      el('p', { text: `Gym Log can’t open its database: ${err.message || err}` }),
      el('p', { text: 'Private browsing modes may block storage. Try a normal window.' })));
  }

  updateUnitLabels();
  resetLogForm();

  $('#log-form').addEventListener('submit', onSaveWorkout);
  // Enter/Return (or "Go" on a phone keyboard) in a field moves to the next
  // field instead of submitting, so validation only runs on "Save workout".
  $('#log-form').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT' || e.isComposing) return;
    e.preventDefault();
    const fields = [...$('#log-form').querySelectorAll('input, textarea')]
      .filter((f) => f.offsetParent !== null && !f.disabled);
    const next = fields[fields.indexOf(e.target) + 1];
    (next || $('#log-form button[type="submit"]')).focus();
  });
  // Once a field has been flagged, clear its error as soon as the user edits it.
  $('#log-form').addEventListener('input', (e) => {
    const f = e.target;
    if (f.getAttribute('aria-invalid') !== 'true') return;
    f.removeAttribute('aria-invalid');
    const row = f.closest('.set-row');
    const err = row ? row.querySelector('.field-error') : $(`#${f.id}-error`);
    if (err && !(row && row.querySelector('[aria-invalid="true"]'))) { err.hidden = true; err.textContent = ''; }
    if (!$('#log-form [aria-invalid="true"]')) $('#log-errors').hidden = true;
  });
  $('#add-set').addEventListener('click', () => {
    const rows = setRows();
    const last = rows[rows.length - 1];
    const values = last ? {
      reps: last.querySelector('[data-name="reps"]').value,
      weight: last.querySelector('[data-name="weight"]').value,
    } : {};
    const row = addSetRow(values);
    row.querySelector('input').focus();
    announce(`Set ${setRows().length} added.`);
  });

  $('#history-exercise').addEventListener('change', (e) => {
    state.historyKey = e.target.value;
    renderHistory();
  });

  $('#export-btn').addEventListener('click', onExport);
  $('#import-form').addEventListener('submit', onImport);
  $('#persist-btn').addEventListener('click', async () => {
    const granted = await requestPersistence();
    await renderStorageStatus();
    announce(granted ? 'Persistent storage granted.' : 'The browser did not grant persistent storage.');
  });

  $('#setting-unit').addEventListener('change', async (e) => {
    state.unit = e.target.value;
    await db.setMeta('unit', state.unit);
    updateUnitLabels();
    announce(`Weights now shown in ${state.unit === 'kg' ? 'kilograms' : 'pounds'}.`);
  });
  $('#setting-reminder').addEventListener('change', async (e) => {
    state.reminderDays = Number(e.target.value);
    await db.setMeta('reminderDays', state.reminderDays);
    announce('Backup reminder updated.');
  });
  $('#snooze-reminder').addEventListener('click', async () => {
    state.snoozedUntil = new Date(Date.now() + DAY).toISOString();
    await db.setMeta('snoozedUntil', state.snoozedUntil);
    $('#backup-reminder').hidden = true;
    announce('We’ll remind you tomorrow.');
    $('#main').focus();
  });

  window.addEventListener('hashchange', () => {
    // In-page anchors such as the skip link (#main) are not routes.
    const h = location.hash.slice(1);
    if (h && !(h in ROUTES)) return;
    showRoute({ focus: true });
  });
  showRoute({ focus: false });

  if (state.workouts.length) requestPersistence();
  registerServiceWorker();
  document.documentElement.dataset.ready = 'true';
}

init();
