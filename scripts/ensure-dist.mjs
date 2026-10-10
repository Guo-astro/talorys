// `wrangler pages dev` needs the output directory to exist; Vite serves the UI in dev.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
const dir = new URL("../apps/web/dist/", import.meta.url);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL("index.html", dir), "<!doctype html><p>Run the Vite dev server on :5173.</p>");
}
