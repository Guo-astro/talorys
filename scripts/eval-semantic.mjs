// Live semantic recall eval (PRD-semantic-slim 10.2): seeds memories on a running instance with
// real Workers AI, asks each case's question(s) in one new conversation and scores the last answer.
// Manual only; never run in CI and never point it at the owner's app: it deletes every memory.
//   TALORYS_EVAL_PASSWORD=... npm run eval:semantic -- --base http://localhost:8787 --yes-wipe [--cases L-car,L-oil]
//   npm run eval:semantic -- --self-test
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseNodeArgs } from "node:util";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "eval-out");
const PENDING_TIMEOUT_MS = 60_000;
const day = (d) => `${d}T12:00:00.000Z`;
const dated = (id, content, d, category = "fact") => ({ id, content, category, created_at: day(d), updated_at: day(d) });
const CARS = [
  dated("eval-car-bug", "I drive a VW Bug from the 60's", "2026-10-09"),
  dated("eval-car-tesla", "I just traded my bug in for a 2025 Tesla.", "2026-10-10"),
];
const at = (id, content, iso, category = "fact") => ({ id, content, category, created_at: iso, updated_at: iso });
/** Andy's own three memories, saved a minute apart on 2026-10-11. */
const ANDY_CARS = [
  at("eval-andy-bug", "My car is a Volkswagen bug from the 1960s.", "2026-10-11T03:30:17.000Z"),
  at("eval-andy-tesla", "I just traded my VW bug away and got a 2025 Tesla.", "2026-10-11T03:31:34.000Z"),
  at("eval-andy-porsche", "I would like to buy a Porsche one day.", "2026-10-11T03:31:42.000Z", "goal"),
];
const RETRACTION = ["correction", "misspoke", "i was wrong", "not a tesla"];
const MEAT = ["chicken", "beef", "pork", "salmon", "fish", "shrimp", "turkey", "bacon", "tuna"];
const NO_OIL = ["no oil", "don't need", "doesn't need", "does not need", "electric"];

/** Lowercases and folds curly apostrophes so "doesn’t" matches "doesn't". */
const fold = (text) => text.replace(/[‘’ʼ]/g, "'").toLowerCase();
const VW = String.raw`(?:vw|volkswagen|bug|beetle)`;
const OLD = String.raw`(?:(?:old|'?60s|vintage|classic) )*`;
/** Owning or driving wording only; "trading in your bug" is not a claim that he still has it. */
const vwIsCurrent = (t) =>
  new RegExp(String.raw`\byou(?: currently)? (?:drive|own|have)s? (?:(?:a|an|the|your) )?${OLD}${VW}\b|\byou(?:'re| are)(?: currently)? driving (?:(?:a|an|the|your) )?${OLD}${VW}\b|\byour (?:car|vehicle) is (?:(?:a|an|the) )?${OLD}${VW}\b`).test(t);
const VW_WORD = new RegExp(String.raw`\b${VW}\b`);
const UPKEEP = /oil changes?|\bevery\b|\bmiles\b|\d,\d{3}|\d{4,}|\bmonths\b|owner's manual|mechanic|service interval/;
/** Splits answer text into sentences and list items. */
const sentences = (t) => t.split(/[.!?\n]+/).filter((s) => s.trim());
/**
 * True when a sentence pairs the VW with upkeep advice. A sentence that also says the Tesla
 * needs no oil is a contrast and passes, unless one of its clauses still pairs the two.
 */
const vwOilAdvice = (t) =>
  /\bfor (?:the|your) (?:vw|bug)\b/.test(t) ||
  sentences(t).some((s) => {
    if (!VW_WORD.test(s) || !UPKEEP.test(s)) return false;
    if (!(s.includes("tesla") && NO_OIL.some((w) => s.includes(w)))) return true;
    return s.split(/, | but /).some((c) => VW_WORD.test(c) && UPKEEP.test(c));
  });
const lacksCarInfo = (t) =>
  t.includes("don't have a record") ||
  sentences(t).some(
    (s) => /\b(?:don't|do not) have (?:any )?(?:information|info|details|a record|records|access)|\bno record of/.test(s) && /\bcar|vehicle|maintenance/.test(s),
  );
const asksWhichCar = (t) => /what (?:kind of |type of |make of )?(?:car|vehicle)[^.?!]*\?/.test(t);

export const CASES = [
  { id: "L-car", gate: true, imports: CARS, query: "What car do I drive?" },
  { id: "L-oil", gate: true, imports: CARS, query: "how often do i need to change the oil on my car" },
  { id: "L-oil-2turn", gate: true, imports: ANDY_CARS, turns: ["What car do I drive?", "How often should I change the oil in my car?"] },
  { id: "L-denver", gate: true, query: "What city do I live in?",
    imports: [dated("eval-city-portland", "I live in Portland", "2026-03-02"), dated("eval-city-denver", "I live in Denver", "2026-09-14")],
    memories: [{ content: "My sister's name is Ana", category: "person" }, { content: "I work as a nurse" }] },
  { id: "L-veg", gate: true, memories: [{ content: "I'm vegetarian", category: "preference" }], query: "give me a dinner idea" },
  { id: "L-peanut", gate: true, query: "Is it OK if I eat a Reese's?",
    memories: [{ content: "I'm allergic to peanuts" }, { content: "I like jazz", category: "preference" }] },
  { id: "L-mountain", gate: false, query: "Plan me a Saturday adventure in the mountains",
    memories: [{ content: "I'm afraid of heights" }, { content: "My knee surgery was in August" }, { content: "My boss is coming over Saturday", category: "person" }] },
  { id: "L-arm", gate: false, memories: [{ content: "I only have one arm" }], query: "Can I play tennis like a regular person?" },
];

/** Scores one answer; returns the list of reasons it fails (empty means pass). L-mountain and L-arm report only. */
export function score(caseId, text) {
  const t = fold(text);
  const plain = t.replace(/\*/g, "");
  const has = (w) => t.includes(w);
  const problems = [];
  const oil = caseId === "L-oil" || caseId === "L-oil-2turn";
  if (caseId === "L-car" || oil) {
    if (!has("tesla")) problems.push("does not mention Tesla");
    if (vwIsCurrent(plain)) problems.push("presents the VW as current");
  }
  if (oil) {
    if (!NO_OIL.some(has)) problems.push("does not say an electric car needs no oil");
    if (vwOilAdvice(plain)) problems.push("gives the VW its own oil advice");
    if (lacksCarInfo(plain)) problems.push("says it lacks info about his car");
    if (asksWhichCar(t)) problems.push("asks what car he drives");
  }
  if (caseId === "L-oil-2turn") for (const w of RETRACTION) if (plain.includes(w)) problems.push(`retracts the Tesla ("${w}")`);
  if (caseId === "L-denver") {
    if (!has("denver")) problems.push("does not mention Denver");
    if (/\byou(?:'re| are)? (?:currently )?(?:live|living|based) in portland|\byou're in portland|\byou are in portland/.test(t)) problems.push("says he lives in Portland");
  }
  if (caseId === "L-veg") for (const w of MEAT) if (new RegExp(`\\b${w}`).test(t)) problems.push(`suggests ${w}`);
  if (caseId === "L-peanut" && !has("peanut") && !has("allerg")) problems.push("mentions neither peanut nor allergy");
  return problems;
}

export function parseArgs(argv) {
  const { values } = parseNodeArgs({
    args: argv,
    options: { base: { type: "string" }, cases: { type: "string" }, "yes-wipe": { type: "boolean" }, "self-test": { type: "boolean" } },
  });
  return values;
}

/** Cookie-carrying client; headers mirror the test client (`x-talorys-request`, `origin`). */
function client(base) {
  const origin = new URL(base).origin;
  let cookie = null;
  return async function call(path, { method = "GET", body } = {}) {
    const res = await fetch(`${origin}/api${path}`, {
      method,
      headers: { "x-talorys-request": "1", origin, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() ?? []) cookie = c.split(";")[0];
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw Object.assign(new Error(`${method} ${path}: ${res.status} ${err.error?.message ?? res.statusText}`), { code: err.error?.code });
    }
    return res;
  };
}

export const login = (call, password) => call("/auth/login", { method: "POST", body: { password } });

const wipe = (call) => call("/memories", { method: "DELETE", body: { confirm: "DELETE" } });

async function seed(call, kase) {
  for (const m of kase.memories ?? []) await call("/memories", { method: "POST", body: m });
  if (kase.imports) {
    const data = { memories: kase.imports };
    await call("/import", { method: "POST", body: { format: "talorys-backup", version: 1, exported_at: new Date().toISOString(), data } });
  }
}

async function waitPending(call) {
  const deadline = Date.now() + PENDING_TIMEOUT_MS;
  for (;;) {
    const { pending } = await (await call("/semantic/status")).json();
    if (pending === 0) return;
    if (Date.now() > deadline) throw new Error(`status pending still ${pending} after ${PENDING_TIMEOUT_MS / 1000}s`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Asks one question and concatenates the streamed text. Without `conversationId` it starts a new
 * conversation; the id from the `start` event is returned so a follow-up can stay in it.
 */
async function ask(call, message, conversationId) {
  const res = await call("/chat", { method: "POST", body: { message, ...(conversationId ? { conversation_id: conversationId } : {}) } });
  const raw = await res.text();
  let text = "";
  let final = null;
  let conversation_id = conversationId ?? null;
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let ev;
    try {
      ev = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    if (ev.type === "start") conversation_id = ev.conversation_id;
    if (ev.type === "error") throw Object.assign(new Error(`${ev.code}: ${ev.message}`), { code: ev.code });
    if (ev.type === "text") text += ev.delta ?? "";
    if (ev.type === "done") final = ev.message?.content ?? text;
  }
  if (final === null) throw new Error("SSE stream ended without a done event");
  return { answer: final || text, conversation_id };
}

// Real L-oil answers from the 2026-10-10 live run; both must fail.
const OIL_RUN1 =
  "I don't have access to your vehicle's maintenance records or service history. However, oil change frequency typically depends on:\n\n- **Vehicle type** - Electric vehicles (like your Tesla) don't need traditional oil changes\n- **Car age** - Older cars (like your VW Bug from the 60's) may need changes every 3,000-5,000 miles\n- **Driving conditions** - Stop-and-go traffic, extreme temperatures, or towing can require more frequent changes\n- **Oil type** - Synthetic oil often lasts longer than conventional oil\n\nFor your **2025 Tesla**, you generally won't need oil changes at all.\n\nFor your **VW Bug**, check your owner's manual for the manufacturer's recommendation, or consult a mechanic for guidance based on your driving habits.\n\nWould you like me to help you create a reminder for your next service appointment?";
const OIL_RUN2 =
  "I don't have information about your car's make, model, or maintenance schedule in your records. Based on what I remember, you've had a VW Bug from the 60's and a 2025 Tesla.\n\nFor the VW Bug, you'd typically need oil changes every 3,000-5,000 miles or every 3-6 months depending on driving conditions.\n\nFor the Tesla, electric vehicles don't require traditional oil changes.\n\nWould you like me to save this question so you don't forget to check your specific maintenance schedule?";

// Real second answer from Andy's same-chat follow-up on 2026-10-10; must fail.
const OIL_2TURN =
  "Quick correction - I misspoke earlier. According to what I have saved, you drive a **1960s VW Beetle**, not a Tesla. Apologies for the confusion!\n\nFor a classic air-cooled Beetle:\n\n- **Every ~3,000 miles or 6 months**, whichever comes first";

function selfTest() {
  const canned = [
    ["L-car", "You drive a 2025 Tesla.", true], ["L-car", "You drive a VW Bug from the 60's.", false],
    ["L-oil", "Your 2025 Tesla is electric, so it doesn’t need oil changes.", true],
    ["L-oil", "Your Tesla needs an oil change every 5,000 miles.", false],
    ["L-oil", "I don't have a record of your car. What car do you drive?", false],
    ["L-oil", "Your Tesla is electric, but your VW Bug needs oil every 3,000 miles.", false],
    ["L-denver", "You live in Denver (you used to live in Portland).", true], ["L-denver", "You live in Portland.", false],
    ["L-veg", "Try a chickpea curry with rice.", true], ["L-veg", "How about grilled salmon?", false],
    ["L-peanut", "No, Reese's contain peanuts and you're allergic.", true], ["L-peanut", "Sure, enjoy!", false],
    ["L-car", "Based on what I remember, you drive a **2025 Tesla**. I saved that detail yesterday when you mentioned trading in your bug for it.", true],
    ["L-car", "Based on what I remember, you drive a **2025 Tesla**. I saved that fact when you mentioned trading in your bug for it on October 10, 2026.", true],
    ["L-car", "Your car is a VW Bug from the 60's.", false],
    ["L-oil", OIL_RUN1, false], ["L-oil", OIL_RUN2, false],
    ["L-oil", "Unlike your old VW Bug, your 2025 Tesla is electric, so it doesn't need oil changes.", true],
    ["L-oil", "I don't have information about your car. Teslas are electric and don't need oil changes.", false],
    ["L-oil-2turn", OIL_2TURN, false],
    ["L-oil-2turn", "Your 2025 Tesla is electric, so it doesn't need oil changes.", true],
  ];
  let failed = 0;
  for (const [id, answer, want] of canned) {
    const ok = (score(id, answer).length === 0) === want;
    console.log(`${ok ? "ok  " : "FAIL"} ${id} ${want ? "accepts" : "rejects"}: ${answer}`);
    if (!ok) failed++;
  }
  return failed ? 1 : 0;
}

/** Prints why the run stopped and returns the usage exit code. */
const refuse = (message) => (console.error(message) ?? 2);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args["self-test"]) return selfTest();
  if (!args.base || !args["yes-wipe"]) return refuse("Refusing to run: pass --base <url> of a throwaway backend and --yes-wipe (every memory there is deleted).");
  const wanted = args.cases ? args.cases.split(",").map((s) => s.trim()).filter(Boolean) : CASES.map((c) => c.id);
  const unknown = wanted.filter((id) => !CASES.some((c) => c.id === id));
  if (unknown.length) return refuse(`Unknown case id(s): ${unknown.join(", ")}`);
  const password = process.env.TALORYS_EVAL_PASSWORD;
  if (!password) return refuse("Set TALORYS_EVAL_PASSWORD to the backend's owner password.");
  const call = client(args.base);
  await login(call, password);
  const results = [];
  for (const kase of CASES.filter((c) => wanted.includes(c.id))) {
    const turns = kase.turns ?? [kase.query];
    const r = { id: kase.id, gate: kase.gate, query: turns.at(-1) };
    try {
      await wipe(call);
      await call("/semantic/config", { method: "PUT", body: { enabled: true } });
      await seed(call, kase);
      await waitPending(call);
      const started = Date.now();
      let conversationId;
      r.answers = [];
      for (const turn of turns) {
        const reply = await ask(call, turn, conversationId);
        conversationId = reply.conversation_id;
        r.answers.push(reply.answer);
      }
      r.answer = r.answers.at(-1);
      r.latency_ms = Date.now() - started;
      r.problems = score(kase.id, r.answer);
      if (kase.id === "L-mountain") r.used = { heights: /height/i.test(r.answer), knee: /knee/i.test(r.answer) };
      if (kase.id === "L-arm") r.used = { one_arm: /\bone arm|one-arm|single arm|one-handed|\barm\b/i.test(r.answer) };
      r.status = r.problems.length ? "fail" : "pass";
    } catch (error) {
      Object.assign(r, { status: "error", error: error.message, code: error.code });
    }
    console.log(`${r.status.padEnd(5)} ${kase.id}${kase.gate ? "" : " (report only)"} ${r.problems?.join("; ") ?? r.error ?? ""}`);
    results.push(r);
  }
  const out = join(OUT_DIR, `semantic-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(out, `${JSON.stringify({ base: new URL(args.base).origin, finished_at: new Date().toISOString(), cases: results }, null, 2)}\n`);
  console.log(`Report written to ${out}`);
  return results.some((r) => r.gate && r.status !== "pass") ? 1 : 0;
}

main().then((code) => process.exit(code), (error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
