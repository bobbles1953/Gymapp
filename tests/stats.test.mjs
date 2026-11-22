import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimate1RM, personalBests, newRecords, parseBackup, sanitizeWorkout, toKg, convert } from '../stats.js';

let n = 0;
const id = () => `id-${++n}`;
const w = (date, sets, unit = 'kg') => ({ id: id(), date, exercise: 'Squat', exerciseKey: 'squat', unit, sets, createdAt: `${date}T10:00:00Z` });

test('unit conversion round-trips', () => {
  assert.ok(Math.abs(toKg(220.46226218, 'lb') - 100) < 1e-6);
  assert.ok(Math.abs(convert(convert(80, 'kg', 'lb'), 'lb', 'kg') - 80) < 1e-9);
});

test('estimate1RM uses Epley on 1–12 reps only', () => {
  assert.equal(estimate1RM(100, 1), 100);
  assert.ok(Math.abs(estimate1RM(100, 10) - 133.333) < 0.01);
  assert.equal(estimate1RM(100, 13), null);
  assert.equal(estimate1RM(0, 5), null);
});

test('personalBests compares across units and keeps the first date on ties', () => {
  const a = w('2026-01-01', [{ reps: 5, weight: 100 }]);
  const b = w('2026-02-01', [{ reps: 5, weight: 220.46226218 }], 'lb'); // = 100 kg, a tie
  const c = w('2026-03-01', [{ reps: 3, weight: 90 }, { reps: 20, weight: 40 }]);
  const pb = personalBests([c, b, a]);
  assert.equal(pb.heaviest.workout, a);
  assert.equal(pb.reps.reps, 20);
  assert.equal(pb.volume.workout, c); // 270 + 800 = 1070 > 500
});

test('newRecords flags beaten records but not the first-ever entry', () => {
  const a = w('2026-01-01', [{ reps: 5, weight: 100 }]);
  assert.deepEqual(newRecords([], a), []);
  const b = w('2026-01-08', [{ reps: 5, weight: 105 }]);
  assert.deepEqual(newRecords([a], b), ['heaviest weight', 'estimated one-rep max', 'session volume']);
  const c = w('2026-01-09', [{ reps: 1, weight: 50 }]);
  assert.deepEqual(newRecords([a, b], c), []);
});

test('sanitizeWorkout rejects bad data', () => {
  assert.equal(sanitizeWorkout({ exercise: 'X', date: '2026-02-30', sets: [{ reps: 1, weight: 1 }] }, id), null);
  assert.equal(sanitizeWorkout({ exercise: '', date: '2026-02-01', sets: [{ reps: 1, weight: 1 }] }, id), null);
  assert.equal(sanitizeWorkout({ exercise: 'X', date: '2026-02-01', sets: [{ reps: 1.5, weight: 1 }] }, id), null);
  assert.equal(sanitizeWorkout({ exercise: 'X', date: '2026-02-01', unit: 'stone', sets: [{ reps: 1, weight: 1 }] }, id), null);
  const ok = sanitizeWorkout({ exercise: '  Bench   Press ', date: '2026-02-01', sets: [{ reps: '5', weight: '60' }] }, id);
  assert.equal(ok.exercise, 'Bench Press');
  assert.equal(ok.exerciseKey, 'bench press');
  assert.deepEqual(ok.sets, [{ reps: 5, weight: 60 }]);
});

test('parseBackup', () => {
  assert.throws(() => parseBackup('not json', id), /not valid JSON/);
  assert.throws(() => parseBackup('{"app":"other","workouts":[]}', id), /not a Gym Log backup/);
  const r = parseBackup(JSON.stringify({ app: 'gymapp', workouts: [
    { exercise: 'A', date: '2026-01-01', sets: [{ reps: 1, weight: 1 }] }, { nope: true }] }), id);
  assert.equal(r.workouts.length, 1);
  assert.equal(r.skipped, 1);
});
