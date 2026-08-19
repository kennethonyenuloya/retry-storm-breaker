import * as core from "@actions/core";
import * as exec from "@actions/exec";
import {
  BreakerConfig,
  canProceed,
  jitteredDelayMs,
  recordOutcome,
} from "./circuitBreaker";
import { loadState, saveState } from "./stateStore";
import { emitSpan } from "./otel";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(): Promise<void> {
  const startTimeMs = Date.now();

  const breakerKey = core.getInput("key", { required: true });
  const command = core.getInput("run", { required: true });
  const shell = core.getInput("shell") || "bash";

  const config: BreakerConfig = {
    failureThreshold: parseInt(core.getInput("failure-threshold") || "5", 10),
    windowSize: parseInt(core.getInput("window-size") || "10", 10),
    openDurationMs:
      parseInt(core.getInput("open-duration-seconds") || "300", 10) * 1000,
    halfOpenMaxCalls: parseInt(core.getInput("half-open-max-calls") || "1", 10),
  };

  const backoffBaseMs = parseInt(core.getInput("backoff-base-ms") || "1000", 10);
  const backoffMaxRetries = parseInt(
    core.getInput("backoff-max-retries") || "3",
    10
  );
  const jitter = (core.getInput("jitter") || "true") === "true";
  const failOnOpen = (core.getInput("fail-on-open") || "true") === "true";

  const otelEndpoint = core.getInput("otel-endpoint");
  const otelHeadersRaw = core.getInput("otel-headers");

  core.info(`retry-storm-breaker: evaluating breaker "${breakerKey}"`);

  let state = await loadState(breakerKey);
  const fromState = state.state;

  const gate = canProceed(state, config, Date.now());
  state = gate.nextState;
  core.info(`retry-storm-breaker: ${gate.reason} (state=${state.state})`);

  if (!gate.allowed) {
    core.setOutput("outcome", "circuit-open");
    core.setOutput("circuit-state", state.state);
    core.setOutput("attempts", "0");
    await saveState(breakerKey, state);

    if (otelEndpoint) {
      await emitSpan({
        endpoint: otelEndpoint,
        headers: parseHeaders(otelHeadersRaw),
        breakerKey,
        fromState,
        toState: state.state,
        outcome: "circuit-open",
        attempts: 0,
        startTimeMs,
        endTimeMs: Date.now(),
      });
    }

    const msg = `Circuit breaker "${breakerKey}" is OPEN — skipping execution to avoid piling onto a struggling dependency. ${gate.reason}.`;
    if (failOnOpen) {
      core.setFailed(msg);
    } else {
      core.warning(msg);
    }
    return;
  }

  // Allowed to attempt — run with jittered retry inside this single
  // breaker-permitted attempt. Retries here are pre-breaker resilience
  // for transient blips; the breaker itself governs cross-run behavior.
  let attempts = 0;
  let success = false;
  let lastError = "";

  for (let attempt = 0; attempt <= backoffMaxRetries; attempt++) {
    attempts++;
    try {
      const exitCode = await exec.exec(shell, ["-c", command], {
        ignoreReturnCode: true,
      });
      if (exitCode === 0) {
        success = true;
        break;
      }
      lastError = `exit code ${exitCode}`;
    } catch (err) {
      lastError = (err as Error).message;
    }

    if (attempt < backoffMaxRetries) {
      const delay = jitteredDelayMs(attempt, backoffBaseMs, jitter);
      core.info(
        `retry-storm-breaker: attempt ${attempts} failed (${lastError}), retrying in ${delay}ms`
      );
      await sleep(delay);
    }
  }

  state = recordOutcome(state, config, success, Date.now());
  await saveState(breakerKey, state);

  const outcome = success ? "success" : "failure";
  core.setOutput("outcome", outcome);
  core.setOutput("circuit-state", state.state);
  core.setOutput("attempts", String(attempts));

  if (otelEndpoint) {
    await emitSpan({
      endpoint: otelEndpoint,
      headers: parseHeaders(otelHeadersRaw),
      breakerKey,
      fromState,
      toState: state.state,
      outcome,
      attempts,
      startTimeMs,
      endTimeMs: Date.now(),
    });
  }

  if (!success) {
    core.setFailed(
      `Command failed after ${attempts} attempt(s): ${lastError}. Circuit is now ${state.state}.`
    );
  } else if (fromState !== "closed" && state.state === "closed") {
    core.info(`retry-storm-breaker: circuit "${breakerKey}" has recovered and is now CLOSED.`);
  }
}

function parseHeaders(raw: string): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

run().catch((err) => {
  core.setFailed(`retry-storm-breaker: unexpected error: ${(err as Error).message}`);
});
