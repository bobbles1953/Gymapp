# Gym Log

A single-user gym tracker that runs entirely in the browser. Plain HTML, CSS and
JavaScript (ES modules). No framework, no build step, no backend. Your data never
leaves your device unless you export it.

## Features

- **Log workouts**: date, exercise, any number of sets (reps and weight), notes.
  "Add set" copies the previous set so you don't retype it.
- **History per exercise**, newest first, with top set and session volume.
- **Personal bests**: heaviest set, estimated one-rep max (Epley, 1 to 12 reps),
  most reps, and best session volume. You're told when a save sets a new record.
- **kg or lb**. Each entry keeps the unit it was logged in, and comparisons are unit-safe.
- **Backup**: JSON export and import (merge or replace) to back up or move to another
  device, plus a configurable "last backup" reminder banner.
- **Storage**: IndexedDB, with `navigator.storage.persist()` requested on first save.
- **Offline and installable**: a service worker precaches the app shell, and the web
  app manifest has standard and maskable icons.
- **Accessibility**: built to WCAG 2.2 AA. See below.

## Run locally

```sh
npm start            # serves the app at http://localhost:8080/
```

Any static file server works. Service workers need `localhost` or HTTPS, so to
install it on a phone, host the folder on any HTTPS static host (GitHub Pages,
Netlify, and so on). All paths are relative, so a sub-path such as `/Gymapp/` works.

## Tests

```sh
npm ci
npm test
```

- `tests/stats.test.mjs`: unit tests for personal-best logic, unit conversion and
  import validation.
- `tests/e2e.test.mjs`: Chromium (Playwright) tests for logging, history, bests,
  delete, export/import round-trip, offline reload, axe-core scans
  (`wcag2a/aa`, `wcag21a/aa`, `wcag22aa`) of every view in light and dark mode,
  320px reflow, and minimum target size.

Playwright here uses an existing Chromium. On a fresh machine, run
`npx playwright install chromium` once.

## Releasing a change

Bump `CACHE_VERSION` in `sw.js` whenever you change a shell file. Installed copies
then show a "Reload to update" banner.

## Accessibility notes

- Landmarks, skip link, one `h1` per view, and focus moves to the view heading on navigation.
- Labelled inputs. Errors are shown in text with `aria-invalid`, `aria-describedby`
  and an error summary that links to each field.
- A polite live region announces saves, deletes, imports and set changes.
- Visible focus indicator (3px outline plus halo). The header is not sticky, so focus is never hidden behind it.
- Targets are at least 44×44px. There are no drag-only interactions.
- Colour contrast is AA in both light and dark themes. State is never shown by colour alone.
- Native `<dialog>` for confirmations, with Cancel focused by default.
- Respects `prefers-reduced-motion` and `forced-colors`. Reflows at 320px. Wide tables scroll in a keyboard-focusable region.

Automated checks catch only part of WCAG. Before relying on conformance, test
manually with a screen reader (VoiceOver on iOS, TalkBack on Android) and with
200% text zoom.

## Data format

```json
{
  "app": "gymapp", "version": 1, "exportedAt": "2026-11-22T10:00:00.000Z",
  "settings": { "unit": "kg", "reminderDays": 7 },
  "workouts": [
    { "id": "uuid", "date": "2026-11-22", "exercise": "Back squat", "unit": "kg",
      "sets": [{ "reps": 5, "weight": 100 }], "notes": "", "createdAt": "…" }
  ]
}
```
