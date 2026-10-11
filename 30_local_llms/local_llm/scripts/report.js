import fs from "node:fs";

import { loadRequests } from "../src/bench.js";
import { renderReport } from "../src/report.js";

/** npm run report: re-render day26_report.md from day26_results.json (no model calls). */

const RESULTS = new URL("../reports/day26_results.json", import.meta.url);
const REPORT = new URL("../reports/day26_report.md", import.meta.url);

const run = JSON.parse(fs.readFileSync(RESULTS, "utf8"));
const ids = new Set(run.results.map((r) => r.request));
fs.writeFileSync(REPORT, renderReport(run, loadRequests().filter((r) => ids.has(r.id))));
console.log("→ reports/day26_report.md");
