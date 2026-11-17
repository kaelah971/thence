// Runs the bundled claim harness in real browser engines (Chromium ≈ Android WebView,
// WebKit ≈ iOS WKWebView). All outside network is aborted; the page answers everything itself.
// Usage: node scripts/claim-harness-browser/run.mjs <bundle.js> <fixture.json> [scenario...]
import { readFileSync } from "node:fs";
import { chromium, webkit } from "playwright";

const [bundlePath, fixturePath, ...scenarioArgs] = process.argv.slice(2);
const bundle = readFileSync(bundlePath, "utf8");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const scenarios = scenarioArgs.length ? scenarioArgs : ["accept"];
const ORIGIN = "https://harness.thence.invalid";

for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await engine.launch();
  const context = await browser.newContext();
  const leaked = [];
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === `${ORIGIN}/`) return route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><script type="module" src="/bundle.js"></script>` });
    if (url === `${ORIGIN}/bundle.js`) return route.fulfill({ status: 200, contentType: "text/javascript", body: bundle });
    leaked.push(url);
    return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => typeof globalThis.runClaimHarness === "function", null, { timeout: 30000 }).catch(() => undefined);
  for (const scenario of scenarios) {
    const result = await page.evaluate(([f, s]) => globalThis.runClaimHarness ? globalThis.runClaimHarness(f, s) : { ok: false, error: "harness did not load" }, [fixture, scenario]);
    console.log(`${name} ${scenario}: ${JSON.stringify(result).slice(0, 700)}`);
  }
  console.log(`${name}: pageErrors=${JSON.stringify(errors)} leakedRequests=${leaked.length} ${leaked.slice(0, 3).join(" ")}`);
  await browser.close();
}
