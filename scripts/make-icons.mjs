// Renders icons/icon.svg to the PNG sizes the manifest needs, using Playwright.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const svg = await readFile(new URL('../icons/icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
const targets = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  // Maskable: full-bleed square background; artwork already sits inside the 80% safe zone.
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
];
for (const t of targets) {
  const art = t.maskable ? svg.replace('rx="96"', 'rx="0"') : svg;
  await page.setViewportSize({ width: t.size, height: t.size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${t.size}px;height:${t.size}px}</style>${art}`);
  await page.screenshot({ path: new URL(`../icons/${t.file}`, import.meta.url).pathname, omitBackground: true });
  console.log('wrote', t.file);
}
await browser.close();
