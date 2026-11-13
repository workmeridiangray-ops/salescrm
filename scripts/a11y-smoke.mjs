// Starts the production build and runs axe on pages that render without a database.
// Usage: npm run build && node scripts/a11y-smoke.mjs
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const PORT = 3111;
const env = { ...process.env, PORT: String(PORT), NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1", NEXT_PUBLIC_SUPABASE_ANON_KEY: "x" };
const server = spawn("npx", ["next", "start", "-p", String(PORT)], { env, stdio: "ignore" });
const PAGES = ["/", "/features", "/demo", "/login", "/login?mode=signup", "/capture/acme"];
const VIEWPORTS = [{ name: "desktop", width: 1280, height: 800 }, { name: "phone", width: 375, height: 700 }];
let failed = 0;
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/features`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: vp });
    const page = await ctx.newPage();
    for (const path of PAGES) {
      const res = await page.goto(`http://127.0.0.1:${PORT}${path}`, { waitUntil: "networkidle" });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const bad = violations.length > 0 || overflow || !res?.ok();
      if (bad) failed++;
      console.log(`${bad ? "FAIL" : "ok  "} ${vp.name.padEnd(7)} ${path}${overflow ? "  [horizontal scroll]" : ""}${res?.ok() ? "" : `  [HTTP ${res?.status()}]`}`);
      for (const v of violations) console.log(`      ${v.id} (${v.impact}): ${v.help} — ${v.nodes.length} element(s)`);
    }
  }
  await browser.close();
} finally { server.kill(); }
process.exit(failed ? 1 : 0);
