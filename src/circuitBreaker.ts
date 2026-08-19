/**
 * retry-storm-breaker — core state machine.
 *
 * Implements the classic Closed -> Open -> Half-Open circuit breaker
 * pattern (Fowler), with a rolling failure window rather than a naive
 * "N failures ever" counter, so a step that has failed 5 times over
 * its entire history but is currently healthy does not stay tripped.
 *
 * This module is pure logic — no network, no filesystem, no GitHub API —
 * so it can be unit tested without mocking Actions internals.
 */

export type CircuitState = "closed" | "open" | "half-open";

export interface CallRecord {
  success: boolean;
  timestampMs: number;
}

export interface BreakerState {
  state: CircuitState;
  window: CallRecord[];
  openedAtMs: number | null;
  halfOpenAttemptsUsed: number;
  /** Monotonically increasing, used only for diagnostics / OTel span linking. */
  transitionCount: number;
}

export interface BreakerConfig {
  failureThreshold: number; // failures needed within window to trip, e.g. 5
  windowSize: number; // number of most recent calls considered, e.g. 10
  openDurationMs: number; // how long to stay Open before probing
  halfOpenMaxCalls: number; // number of probe calls allowed in Half-Open
}

export function initialState(): BreakerState {
  return {
    state: "closed",
    window: [],
    openedAtMs: null,
    halfOpenAttemptsUsed: 0,
    transitionCount: 0,
  };
}

/**
 * Decide whether a call is allowed right now, given the current state
 * and config. This is checked BEFORE executing the wrapped command.
 */
export function canProceed(
  state: BreakerState,
  config: BreakerConfig,
  nowMs: number
): { allowed: boolean; nextState: BreakerState; reason: string } {
  if (state.state === "closed") {
    return { allowed: true, nextState: state, reason: "circuit closed" };
  }

  if (state.state === "open") {
    const openedAt = state.openedAtMs ?? nowMs;
    const elapsed = nowMs - openedAt;
    if (elapsed >= config.openDurationMs) {
      // Cooldown elapsed — transition to half-open and allow this call
      // as the first probe.
      const nextState: BreakerState = {
        ...state,
        state: "half-open",
        halfOpenAttemptsUsed: 0,
        transitionCount: state.transitionCount + 1,
      };
      return {
        allowed: true,
        nextState,
        reason: "cooldown elapsed, probing in half-open",
      };
    }
    return {
      allowed: false,
      nextState: state,
      reason: `circuit open, ${Math.ceil((config.openDurationMs - elapsed) / 1000)}s remaining in cooldown`,
    };
  }

  // half-open
  if (state.halfOpenAttemptsUsed < config.halfOpenMaxCalls) {
    return {
      allowed: true,
      nextState: state,
      reason: "half-open probe slot available",
    };
  }
  return {
    allowed: false,
    nextState: state,
    reason: "half-open probe budget exhausted, waiting on in-flight result",
  };
}

/**
 * Record the outcome of a call that was allowed to proceed, and compute
 * the resulting state. This is the only place transitions happen.
 */
export function recordOutcome(
  state: BreakerState,
  config: BreakerConfig,
  success: boolean,
  nowMs: number
): BreakerState {
  const record: CallRecord = { success, timestampMs: nowMs };

  if (state.state === "half-open") {
    const attemptsUsed = state.halfOpenAttemptsUsed + 1;

    if (success) {
      // Probe succeeded. Only fully close once ALL half-open budget
      // has succeeded, so a single lucky call doesn't reopen the
      // floodgates while the service is still recovering.
      if (attemptsUsed >= config.halfOpenMaxCalls) {
        return {
          state: "closed",
          window: [record],
          openedAtMs: null,
          halfOpenAttemptsUsed: 0,
          transitionCount: state.transitionCount + 1,
        };
      }
      return {
        ...state,
        halfOpenAttemptsUsed: attemptsUsed,
      };
    }

    // Probe failed -> straight back to open, cooldown restarts.
    return {
      state: "open",
      window: [...state.window, record].slice(-config.windowSize),
      openedAtMs: nowMs,
      halfOpenAttemptsUsed: 0,
      transitionCount: state.transitionCount + 1,
    };
  }

  // closed state: append to rolling window, evaluate threshold
  const window = [...state.window, record].slice(-config.windowSize);
  const failures = window.filter((r) => !r.success).length;

  if (failures >= config.failureThreshold) {
    return {
      state: "open",
      window,
      openedAtMs: nowMs,
      halfOpenAttemptsUsed: 0,
      transitionCount: state.transitionCount + 1,
    };
  }

  return {
    ...state,
    window,
  };
}

/** Full jitter backoff per AWS's "Exponential Backoff and Jitter" formula. */
export function jitteredDelayMs(
  attempt: number,
  baseMs: number,
  jitter: boolean
): number {
  const cap = baseMs * Math.pow(2, attempt);
  if (!jitter) return cap;
  return Math.floor(Math.random() * cap);
}
