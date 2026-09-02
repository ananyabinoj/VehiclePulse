/**
 * Null-safety audit for the pages, standing in for a render test.
 *
 * There is no DOM and no working bundler in this sandbox, so the UI cannot be mounted. The
 * crash class that actually matters here is calling a method on an API field that the server
 * legitimately returns as null — an untriaged report has no severity, theme or summary, and a
 * theme can have an unknown vehicle count. This walks every `a.b.method()` in src/ and flags
 * any whose base field is null in a real API payload and which is not written defensively.
 *
 * Run against a live server that has imported and partially triaged reports.
 */
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import fs from "fs";
import path from "path";

const traverse = traverseModule.default || traverseModule;
const B = process.env.BASE || "http://127.0.0.1:8787";

const get = async (p) => (await fetch(`${B}${p}`)).json();

/** Keys that are null/undefined in at least one real record of a live payload. */
function nullableKeys(records) {
  const nullable = new Set();
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    for (const [k, v] of Object.entries(r)) if (v === null || v === undefined) nullable.add(k);
  }
  return nullable;
}

const reports = await get("/api/reports");
const themesPayload = await get("/api/themes");
const themes = themesPayload.themes || [];
const detail = themes.length ? await get(`/api/themes/${themes[0].id}`) : {};
const analyzed = await (
  await fetch(`${B}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Wipers stopped mid-drive in rain, one vehicle, dealer replaced the motor." }),
  })
).json();

const nullable = new Set([
  ...nullableKeys(reports),
  ...nullableKeys(themes),
  ...nullableKeys([detail, ...(detail.reports || [])]),
  ...nullableKeys([analyzed, analyzed.triage || {}, ...(analyzed.similar || [])]),
  ...nullableKeys([themesPayload.stats || {}, themesPayload.clustering || {}, themesPayload.untriaged || {}]),
]);

console.log(`corpus: ${reports.length} reports, ${themes.length} themes`);
console.log(`untriaged: ${reports.filter((r) => r.analysisStatus !== "analyzed").length}`);
console.log(`nullable API fields observed (${nullable.size}): ${[...nullable].sort().join(", ")}\n`);

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.jsx?$/.test(e.name)) files.push(p);
  }
})("src");

const findings = [];
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const lines = src.split("\n");
  const ast = parse(src, { sourceType: "module", plugins: ["jsx"] });
  traverse(ast, {
    CallExpression(p) {
      const callee = p.node.callee;
      if (callee.type !== "MemberExpression") return;
      const obj = callee.object;
      // `a.b.method()` — the risky shape. `a.b?.method()` and `(a.b || x).method()` are fine.
      if (obj.type !== "MemberExpression" || obj.computed) return;
      if (callee.optional) return;
      const field = obj.property.name;
      if (!nullable.has(field)) return;
      const method = callee.property.name;
      findings.push({
        file: f,
        line: obj.loc.start.line,
        code: lines[obj.loc.start.line - 1].trim().slice(0, 110),
        field,
        method,
      });
    },
  });
}

if (!findings.length) {
  console.log("PASS — no method call on a field the API can return as null.");
  process.exit(0);
}
console.log(`FAIL — ${findings.length} unguarded call(s) on a nullable API field:`);
for (const f of findings) {
  console.log(`  ${f.file}:${f.line}  .${f.field}.${f.method}()  ->  ${f.code}`);
}
process.exit(1);
