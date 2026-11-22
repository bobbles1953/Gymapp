// End-to-end tests in Chromium: logging, history, bests, backup round-trip,
// offline reload, and axe-core WCAG 2.2 AA scans of every view in light and dark mode.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from '../scripts/serve.mjs';

const require = createRequire(import.meta.url);
const AXE = await readFile(require.resolve('axe-core/axe.min.js'), 'utf8');
const VIEWS = ['log', 'history', 'bests', 'backup'];

let server, browser, base;
before(async () => {
  server = await startServer(0);
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

async function freshPage(opts = {}) {
  const context = await browser.newContext({ acceptDownloads: true, ...opts });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.waitForSelector('html[data-ready="true"]');
  return { context, page, errors };
}

async function logWorkout(page, { exercise, date, sets }) {
  await page.goto(`${base}#log`);
  if (date) await page.fill('#f-date', date);
  await page.fill('#f-exercise', exercise);
  for (let i = 0; i < sets.length; i++) {
    if (i > 0) await page.click('#add-set');
    const row = page.locator('#set-rows .set-row').nth(i);
    await row.locator('[data-name="reps"]').fill(String(sets[i].reps));
    await row.locator('[data-name="weight"]').fill(String(sets[i].weight));
  }
  await page.click('#log-form button[type="submit"]');
  await page.waitForSelector('#log-result:not([hidden])');
  return page.textContent('#log-result');
}

async function axeScan(page) {
  await page.addScriptTag({ content: AXE });
  return page.evaluate(async () => {
    const r = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    });
    return r.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

test('validation errors are announced and linked', async () => {
  const { context, page } = await freshPage();
  assert.equal(await page.isVisible('.remove-set'), false, 'a lone set cannot be removed');
  await page.click('#add-set');
  assert.equal(await page.locator('.remove-set:visible').count(), 2);
  await page.click('.remove-set >> nth=1');
  assert.equal(await page.isVisible('.remove-set'), false);
  await page.click('#log-form button[type="submit"]');
  assert.equal(await page.isVisible('#log-errors'), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'log-errors');
  assert.equal(await page.getAttribute('#f-exercise', 'aria-invalid'), 'true');
  const describedBy = await page.getAttribute('#f-exercise', 'aria-describedby');
  assert.match(describedBy, /f-exercise-error/);
  await page.click('#log-error-list a >> nth=0');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'f-exercise');
  await context.close();
});

test('log, history, bests, delete', async () => {
  const { context, page, errors } = await freshPage();
  await logWorkout(page, { exercise: 'Back squat', date: '2026-01-05', sets: [{ reps: 5, weight: 100 }, { reps: 5, weight: 100 }] });
  const msg = await logWorkout(page, { exercise: 'back  squat', date: '2026-01-12', sets: [{ reps: 3, weight: 110 }] });
  assert.match(msg, /New personal best: heaviest weight/);
  await logWorkout(page, { exercise: 'Pull-up', sets: [{ reps: 10, weight: 0 }] });

  await page.goto(`${base}#history`);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'history-heading');
  assert.equal(await page.title(), 'History – Gym Log');
  const options = await page.$$eval('#history-exercise option', (o) => o.map((x) => x.textContent));
  assert.deepEqual(options, ['Back squat (2)', 'Pull-up (1)']);
  assert.match(await page.textContent('#history-content'), /2 × 5 @ 100 kg/);

  await page.goto(`${base}#bests`);
  const bests = await page.textContent('#bests-content');
  assert.match(bests, /110 kg × 3/);
  assert.match(bests, /10 reps/);

  await page.goto(`${base}#history`);
  await page.click('#history-content tbody tr:first-child .button-link');
  assert.equal(await page.isVisible('#confirm-dialog'), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'confirm-cancel');
  await page.click('#confirm-ok');
  await page.waitForFunction(() => !document.querySelector('#confirm-dialog').open);
  await page.waitForFunction(() => document.querySelectorAll('#history-content tbody tr').length === 1);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'history-heading');
  assert.match(await page.textContent('#announcer'), /Deleted/);
  assert.deepEqual(errors, []);
  await context.close();
});

test('backup reminder, export and import round-trip', async () => {
  const { context, page } = await freshPage();
  await logWorkout(page, { exercise: 'Deadlift', date: '2026-02-01', sets: [{ reps: 5, weight: 140 }] });
  await page.goto(`${base}#log`);
  assert.equal(await page.isVisible('#backup-reminder'), true);

  await page.goto(`${base}#backup`);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-btn')]);
  const dir = await mkdtemp(join(tmpdir(), 'gymapp-'));
  const file = join(dir, download.suggestedFilename());
  await download.saveAs(file);
  const data = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(data.app, 'gymapp');
  assert.equal(data.workouts.length, 1);
  await page.waitForFunction(() => /today/.test(document.querySelector('#last-backup-text').textContent));
  await page.goto(`${base}#log`);
  assert.equal(await page.isVisible('#backup-reminder'), false);

  // Import into a brand-new profile (= another device).
  const other = await freshPage();
  await other.page.goto(`${base}#backup`);
  await other.page.setInputFiles('#import-file', file);
  await other.page.click('#import-form button[type="submit"]');
  await other.page.waitForSelector('#import-result:not([hidden])');
  assert.match(await other.page.textContent('#import-result'), /Imported 1 entry/);
  // Merging the same file again must not duplicate.
  await other.page.setInputFiles('#import-file', file);
  await other.page.click('#import-form button[type="submit"]');
  await other.page.waitForFunction(() => /You now have 1 entries/.test(document.querySelector('#import-result').textContent));

  const bad = join(dir, 'bad.json');
  await writeFile(bad, '{"hello":1}');
  await other.page.setInputFiles('#import-file', bad);
  await other.page.click('#import-form button[type="submit"]');
  await other.page.waitForSelector('#import-file-error:not([hidden])');
  assert.match(await other.page.textContent('#import-file-error'), /not a Gym Log backup/);
  await other.context.close();
  await context.close();
});

test('works offline after first visit', async () => {
  const { context, page } = await freshPage();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await logWorkout(page, { exercise: 'Offline row', sets: [{ reps: 8, weight: 50 }] });
  await page.goto(`${base}#bests`);
  assert.match(await page.textContent('#bests-content'), /Offline row/);
  const manifest = await page.evaluate(async () => (await fetch('manifest.webmanifest')).json());
  assert.equal(manifest.display, 'standalone');
  await context.close();
});

for (const colorScheme of ['light', 'dark']) {
  test(`axe WCAG 2.2 AA: all views, ${colorScheme} mode, empty and populated`, async () => {
    const { context, page } = await freshPage({ colorScheme });
    const failures = [];
    for (const v of VIEWS) {
      await page.goto(`${base}#${v}`);
      failures.push(...(await axeScan(page)).map((x) => `[empty ${v}] ${x}`));
    }
    await logWorkout(page, { exercise: 'Bench press', sets: [{ reps: 5, weight: 80 }] });
    await page.click('#log-form button[type="submit"]'); // show the error state too
    failures.push(...(await axeScan(page)).map((x) => `[log errors] ${x}`));
    for (const v of VIEWS) {
      await page.goto(`${base}#${v}`);
      failures.push(...(await axeScan(page)).map((x) => `[filled ${v}] ${x}`));
    }
    await page.goto(`${base}#history`);
    await page.click('#history-content .button-link');
    failures.push(...(await axeScan(page)).map((x) => `[dialog] ${x}`));
    assert.deepEqual(failures, []);
    await context.close();
  });
}

test('reflows at 320 CSS px without horizontal page scroll', async () => {
  const { context, page } = await freshPage({ viewport: { width: 320, height: 640 } });
  await logWorkout(page, { exercise: 'Bench press', sets: [{ reps: 5, weight: 80 }, { reps: 5, weight: 80 }] });
  for (const v of VIEWS) {
    await page.goto(`${base}#${v}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `${v} overflows by ${overflow}px`);
  }
  await context.close();
});

test('interactive targets are at least 24×24 CSS px', async () => {
  const { context, page } = await freshPage();
  await logWorkout(page, { exercise: 'Bench press', sets: [{ reps: 5, weight: 80 }] });
  const small = [];
  for (const v of VIEWS) {
    await page.goto(`${base}#${v}`);
    small.push(...await page.evaluate(() => [...document.querySelectorAll('main a, main button, main input, main select, header a')]
      .filter((e) => e.offsetParent !== null && !e.closest('p, li:not(.set-row):not(.nav-list li)'))
      .map((e) => ({ e, r: e.getBoundingClientRect() }))
      .filter(({ r }) => r.width < 24 || r.height < 24)
      .map(({ e, r }) => `${e.tagName}#${e.id}.${e.className} ${r.width}x${r.height}`)));
  }
  assert.deepEqual(small, []);
  await context.close();
});
