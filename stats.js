// Pure functions: unit conversion, validation, personal bests. No DOM, no IndexedDB.

export const LB_PER_KG = 2.2046226218;

export function toKg(weight, unit) {
  return unit === 'lb' ? weight / LB_PER_KG : weight;
}

export function convert(weight, from, to) {
  if (from === to) return weight;
  return to === 'lb' ? weight * LB_PER_KG : weight / LB_PER_KG;
}

/** Epley estimate, only meaningful for 1–12 reps. Returns null otherwise. */
export function estimate1RM(weight, reps) {
  if (!(weight > 0) || reps < 1 || reps > 12) return null;
  return reps === 1 ? weight : weight * (1 + reps / 30);
}

export function volumeKg(workout) {
  return workout.sets.reduce((sum, s) => sum + s.reps * toKg(s.weight, workout.unit), 0);
}

/** The heaviest set in a workout (ties broken by reps). */
export function topSet(workout) {
  let best = null;
  for (const s of workout.sets) {
    if (!best || s.weight > best.weight || (s.weight === best.weight && s.reps > best.reps)) best = s;
  }
  return best;
}

/** Sort newest first: by date, then by creation time. */
export function byNewest(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  return (b.createdAt || '').localeCompare(a.createdAt || '');
}

/** Group workouts by exerciseKey. Display name = name used most recently. */
export function groupByExercise(workouts) {
  const groups = new Map();
  for (const w of [...workouts].sort(byNewest)) {
    if (!groups.has(w.exerciseKey)) groups.set(w.exerciseKey, { key: w.exerciseKey, name: w.exercise, workouts: [] });
    groups.get(w.exerciseKey).workouts.push(w);
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Personal bests for one exercise's workouts. All comparisons in kg.
 * Returns { heaviest, e1rm, volume, reps } — each { valueKg|reps, workout, set } or null.
 */
export function personalBests(workouts) {
  let heaviest = null, e1rm = null, volume = null, reps = null;
  // Oldest first so the *first* time a record was set wins ties.
  const ordered = [...workouts].sort((a, b) => -byNewest(a, b));
  for (const w of ordered) {
    for (const s of w.sets) {
      const kg = toKg(s.weight, w.unit);
      if (kg > 0 && (!heaviest || kg > heaviest.valueKg + 1e-9 ||
          (Math.abs(kg - heaviest.valueKg) < 1e-9 && s.reps > heaviest.set.reps))) {
        heaviest = { valueKg: kg, workout: w, set: s };
      }
      const est = estimate1RM(kg, s.reps);
      if (est !== null && (!e1rm || est > e1rm.valueKg + 1e-9)) e1rm = { valueKg: est, workout: w, set: s };
      if (!reps || s.reps > reps.reps) reps = { reps: s.reps, workout: w, set: s };
    }
    const v = volumeKg(w);
    if (v > 0 && (!volume || v > volume.valueKg + 1e-9)) volume = { valueKg: v, workout: w };
  }
  return { heaviest, e1rm, volume, reps };
}

/** Which records does `candidate` set, compared to `previous` workouts of the same exercise? */
export function newRecords(previous, candidate) {
  const before = personalBests(previous);
  const after = personalBests([...previous, candidate]);
  const records = [];
  if (!previous.length) return records; // first ever entry is not a "new" PB
  const beat = (a, b) => b && b.workout === candidate && (!a || b.valueKg > a.valueKg + 1e-9);
  if (beat(before.heaviest, after.heaviest)) records.push('heaviest weight');
  if (beat(before.e1rm, after.e1rm)) records.push('estimated one-rep max');
  if (beat(before.volume, after.volume)) records.push('session volume');
  return records;
}

// ---------- Import validation ----------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Returns a clean workout object, or null if `raw` is not a valid workout. */
export function sanitizeWorkout(raw, makeId) {
  if (!raw || typeof raw !== 'object') return null;
  const exercise = typeof raw.exercise === 'string' ? raw.exercise.trim().replace(/\s+/g, ' ') : '';
  if (!exercise || exercise.length > 100) return null;
  if (!isValidDate(raw.date)) return null;
  const unit = raw.unit === 'lb' ? 'lb' : raw.unit === 'kg' || raw.unit === undefined ? 'kg' : null;
  if (!unit) return null;
  if (!Array.isArray(raw.sets) || raw.sets.length < 1 || raw.sets.length > 100) return null;
  const sets = [];
  for (const s of raw.sets) {
    const r = Number(s?.reps), wt = Number(s?.weight);
    if (!Number.isInteger(r) || r < 1 || r > 1000) return null;
    if (!Number.isFinite(wt) || wt < 0 || wt > 2000) return null;
    sets.push({ reps: r, weight: wt });
  }
  const id = typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 100 ? raw.id : makeId();
  const notes = typeof raw.notes === 'string' ? raw.notes.slice(0, 500) : '';
  const createdAt = typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt))
    ? raw.createdAt : new Date().toISOString();
  return { id, date: raw.date, exercise, exerciseKey: exercise.toLowerCase(), unit, sets, notes, createdAt };
}

/** Parse an export file's text. Returns { workouts, skipped } or throws Error with a readable message. */
export function parseBackup(text, makeId) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('The file is not valid JSON.'); }
  const list = Array.isArray(data) ? data : data?.workouts;
  if (!data || (data.app !== undefined && data.app !== 'gymapp') || !Array.isArray(list)) {
    throw new Error('The file is not a Gym Log backup.');
  }
  const workouts = [];
  let skipped = 0;
  for (const raw of list) {
    const w = sanitizeWorkout(raw, makeId);
    if (w) workouts.push(w); else skipped++;
  }
  return { workouts, skipped, settings: data.settings && typeof data.settings === 'object' ? data.settings : null };
}
