import fs from "node:fs";
import vm from "node:vm";

const db = JSON.parse(fs.readFileSync(new URL("../data/aniskip_data.json", import.meta.url), "utf8"));
if (!db || typeof db !== "object" || Array.isArray(db)) throw new Error("Database root must be an object");
const source = fs.readFileSync(new URL("../api/record.js", import.meta.url), "utf8")
  .replace(/export default async function handler/, "async function handler")
  .replace(/^export \{[^\n]+\};/gm, '');
new vm.Script(source, { filename: "api/record.js" });
const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
for (const file of ['app.js', 'extract.js']) {
  const source = fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
  new vm.Script(source, { filename: file });
}
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
for (const match of app.matchAll(/\$\('([^']+)'\)/g)) if (!ids.has(match[1])) throw new Error(`Missing UI element: ${match[1]}`);
console.log(`OK: ${Object.keys(db).length} anime records; API and frontend syntax valid.`);
