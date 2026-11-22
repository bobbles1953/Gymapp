// IndexedDB wrapper for Gym Log. One store for workouts, one for key/value meta.

const DB_NAME = 'gymapp';
const DB_VERSION = 1;

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('workouts')) {
        const store = db.createObjectStore('workouts', { keyPath: 'id' });
        store.createIndex('exerciseKey', 'exerciseKey');
        store.createIndex('date', 'date');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab is upgrading: let it.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => reject(new Error('Close other Gym Log tabs and reload.'));
  });
  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(storeNames, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let result;
    Promise.resolve(fn(tx)).then((r) => { result = r; }, (err) => { tx.abort(); reject(err); });
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

export const exerciseKey = (name) => name.trim().replace(/\s+/g, ' ').toLowerCase();

export function getAllWorkouts() {
  return run('workouts', 'readonly', (tx) => reqToPromise(tx.objectStore('workouts').getAll()));
}

export function putWorkout(workout) {
  return run('workouts', 'readwrite', (tx) => { tx.objectStore('workouts').put(workout); });
}

export function deleteWorkout(id) {
  return run('workouts', 'readwrite', (tx) => { tx.objectStore('workouts').delete(id); });
}

/** Insert many workouts in one transaction. mode: 'merge' (upsert by id) | 'replace'. */
export function importWorkouts(workouts, mode) {
  return run('workouts', 'readwrite', (tx) => {
    const store = tx.objectStore('workouts');
    if (mode === 'replace') store.clear();
    for (const w of workouts) store.put(w);
  });
}

export async function getMeta(key, fallback = null) {
  const row = await run('meta', 'readonly', (tx) => reqToPromise(tx.objectStore('meta').get(key)));
  return row ? row.value : fallback;
}

export function setMeta(key, value) {
  return run('meta', 'readwrite', (tx) => { tx.objectStore('meta').put({ key, value }); });
}
