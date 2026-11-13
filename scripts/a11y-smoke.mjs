// Starts the production build and runs axe on pages that render without a database.
// Usage: npm run build && node scripts/a11y-smoke.mjs
import { spawn } from "node:child_process";
import http from "node:http";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

const PORT = 3111, MOCK = 3112;
// A tiny stand-in for Supabase's REST API so pages that read public data can render for the accessibility check.
const day = (n, h) => new Date(Date.UTC(2030, 0, 7 + n, h, 0, 0)).toISOString();
const answers = {
  booking_slots: { title: "Intro call", duration_min: 30, tz: "UTC", company: "Acme Distribution", host: "Asha Rao", slots: [day(0, 9), day(0, 9.5), day(0, 10), day(1, 9), day(1, 11)].map((d) => d) },
  meeting_for_token: { title: "Intro call", starts_at: day(2, 10), ends_at: day(2, 10.5), status: "scheduled", tz: "UTC", slug: "acme-intro", company: "Acme Distribution", can_cancel: true },
  quote_for_review: { company: "Acme Distribution", number: "Q-00001", version: 1, status: "sent", expired: false, valid_until: "2030-02-01", notes: "Thank you.", discount_pct: 10, subtotal: 2000, discount_total: 200, tax_total: 324, total: 2124, lines: [{ description: "Widget", qty: 2, unit_price: 1000, tax_rate: 18 }] },
};
const plans = [{ key: "starter", name: "Starter", monthly_inr: 1499, yearly_inr: 14990, max_users: 3 }, { key: "growth", name: "Growth", monthly_inr: 4999, yearly_inr: 49990, max_users: 15 }];
const mock = http.createServer((req, res) => {
  const m = req.url.match(/\/rest\/v1\/rpc\/(\w+)/);
  res.setHeader("content-type", "application/json");
  if (m && answers[m[1]]) return res.end(JSON.stringify(answers[m[1]]));
  if (req.url.startsWith("/rest/v1/plans")) return res.end(JSON.stringify(plans));
  res.statusCode = 404; res.end("{}");
});
await new Promise((r) => mock.listen(MOCK, "127.0.0.1", r));
const env = { ...process.env, PORT: String(PORT), NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${MOCK}`, NEXT_PUBLIC_SUPABASE_ANON_KEY: "x" };
const server = spawn("npx", ["next", "start", "-p", String(PORT)], { env, stdio: "ignore" });
const PAGES = ["/", "/features", "/pricing", "/demo", "/login", "/login?mode=signup", "/capture/acme", "/book/acme-intro", "/book/acme-intro?day=2030-01-07&at=" + encodeURIComponent(day(0, 9)), "/m/sometoken", "/quote/sometoken", "/u/sometoken"];
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
} finally { server.kill(); mock.close(); }
process.exit(failed ? 1 : 0);
