import { execSync } from "child_process";
execSync("npx tsc -p tsconfig.json --outDir lib", { stdio: "inherit", cwd: process.cwd() });

const { initialState, canProceed, recordOutcome, jitteredDelayMs } = await import("../lib/circuitBreaker.js");

let state = initialState();
const config = { failureThreshold: 3, windowSize: 5, openDurationMs: 1000, halfOpenMaxCalls: 1 };
let now = 0;
let failed = false;

function assert(cond, msg) {
  if (!cond) { console.error("FAIL:", msg); failed = true; }
  else console.log("PASS:", msg);
}

let gate = canProceed(state, config, now);
assert(gate.allowed && state.state === "closed", "starts closed and allows calls");

for (let i = 0; i < 3; i++) state = recordOutcome(state, config, false, now);
assert(state.state === "open", "trips open after 3 failures within window");

gate = canProceed(state, config, now + 500);
assert(!gate.allowed, "blocks calls while cooldown active");

gate = canProceed(state, config, now + 1500);
assert(gate.allowed && gate.nextState.state === "half-open", "transitions to half-open after cooldown");
state = gate.nextState;

state = recordOutcome(state, config, true, now + 1600);
assert(state.state === "closed", "closes breaker after successful half-open probe");

for (let i = 0; i < 3; i++) state = recordOutcome(state, config, false, now + 2000);
assert(state.state === "open", "re-trips open");
gate = canProceed(state, config, now + 2000 + 1500);
state = gate.nextState;
state = recordOutcome(state, config, false, now + 2000 + 1600);
assert(state.state === "open", "failed probe sends breaker back to open");

const d = jitteredDelayMs(2, 1000, true);
assert(d >= 0 && d <= 4000, `jittered delay within bounds (got ${d})`);

const noJitter = jitteredDelayMs(2, 1000, false);
assert(noJitter === 4000, `no-jitter delay exact (got ${noJitter})`);

if (failed) { console.error("\nSOME CHECKS FAILED"); process.exit(1); }
console.log("\nAll checks passed.");