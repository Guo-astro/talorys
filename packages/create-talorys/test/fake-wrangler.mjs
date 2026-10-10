#!/usr/bin/env node
// A stand-in for the Wrangler CLI used by installer tests. It simulates one or
// more Cloudflare accounts in a JSON state file (FAKE_CF_STATE) and records
// every invocation, so tests can assert idempotency and failure recovery.
//
// Failure injection: state.failNext = { "<command key>": "<stderr text>" } fails
// the next matching call once. Command keys: "deploy", "pages deploy",
// "pages project create", "secret bulk", "whoami".
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const statePath = process.env.FAKE_CF_STATE;
if (!statePath) {
  console.error("FAKE_CF_STATE not set");
  process.exit(2);
}
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : { loggedIn: true, accounts: [{ id: "acc1", name: "Personal Account" }], workers: {}, pages: {}, calls: [], failNext: {} };
const args = process.argv.slice(2);
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? state.accounts[0]?.id;
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const key = args[0] === "pages" ? `pages ${args[1] === "project" ? `project ${args[2]}` : args[1]}` : args[0] === "secret" ? `secret ${args[1]}` : args[0];
state.calls.push({ key, args: args.filter((a) => !a.startsWith("{")), account });

function fail(message) {
  save();
  process.stderr.write(`✘ [ERROR] ${message}\n`);
  process.exit(1);
}
if (state.failNext?.[key]) {
  const msg = state.failNext[key];
  delete state.failNext[key];
  fail(msg);
}

const ws = (state.workers[account] ??= {});
const ps = (state.pages[account] ??= {});

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

switch (key) {
  case "--version":
    console.log("4.149.0 (fake)");
    break;
  case "whoami":
    if (!state.loggedIn) fail("Not logged in");
    console.log(JSON.stringify({ loggedIn: true, authType: "OAuth Token", email: "owner@example.com", accounts: state.accounts }));
    break;
  case "login":
    state.loggedIn = true;
    break;
  case "deployments": {
    const name = flag("--name");
    if (!ws[name]) fail(`This Worker does not exist on your account. [code: 10007]`);
    console.log(JSON.stringify([{ id: "dep" }]));
    break;
  }
  case "secret list": {
    const name = flag("--name");
    if (!ws[name]) fail(`Worker not found [code: 10007]`);
    console.log(JSON.stringify(Object.keys(ws[name].secrets).map((n) => ({ name: n, type: "secret_text" }))));
    break;
  }
  case "secret bulk": {
    const name = flag("--name");
    const input = JSON.parse(await readStdin());
    if (!ws[name]) fail(`Worker not found [code: 10007]`);
    for (const [k, v] of Object.entries(input)) ws[name].secrets[k] = { length: String(v).length, prefix: String(v).slice(0, 14) };
    console.log(`✨ ${Object.keys(input).length} secrets successfully uploaded`);
    break;
  }
  case "deploy": {
    const config = flag("--config");
    const text = readFileSync(config, "utf8").replace(/^\s*\/\/.*$/gm, "");
    const cfg = JSON.parse(text);
    const existing = ws[cfg.name];
    if (existing && JSON.stringify(existing.migrations) !== JSON.stringify(cfg.migrations.slice(0, existing.migrations.length))) {
      fail("Migrations must be append-only");
    }
    ws[cfg.name] = {
      secrets: existing?.secrets ?? {},
      migrations: cfg.migrations,
      workers_dev: cfg.workers_dev,
      vars: cfg.vars,
      deploys: (existing?.deploys ?? 0) + 1,
      durableObjectData: existing?.durableObjectData ?? "owner-data",
    };
    console.log(`Uploaded ${cfg.name}\nCurrent Version ID: 11111111-2222-3333-4444-555555555555`);
    break;
  }
  case "pages project list":
    console.log(JSON.stringify(Object.keys(ps).map((n) => ({ "Project Name": n, "Project Domains": `${ps[n].subdomain}`, "Git Provider": "No" }))));
    break;
  case "pages project create": {
    const name = args[3];
    if (ps[name]) fail(`A project with this name already exists [code: 8000002]`);
    ps[name] = { subdomain: `${name}${state.subdomainSuffix ?? ""}.pages.dev`, deployments: 0 };
    console.log(`✨ Successfully created the '${name}' project.`);
    break;
  }
  case "pages deploy": {
    const name = flag("--project-name");
    if (!ps[name]) fail(`Project not found [code: 8000007]`);
    ps[name].deployments += 1;
    console.log(`✨ Deployment complete! Take a peek over at https://abc123.${ps[name].subdomain}`);
    break;
  }
  case "ai":
    console.log(JSON.stringify({ input: {}, output: {} }));
    break;
  default:
    fail(`fake-wrangler: unsupported command ${args.join(" ")}`);
}
save();
