/**
 * Cross-run state persistence.
 *
 * This is the actual differentiator of this Action: GitHub's cache API
 * only lets you WRITE a given key once (a second save to the same key
 * returns 409 Conflict), which is why every other "retry" action on the
 * Marketplace only holds state for the current job. We work around that
 * with a timestamp-suffixed key plus restoreKeys prefix matching:
 *
 *   save key:    cb-state-<breakerKey>-<isoTimestamp>   (always unique)
 *   restore key: cb-state-<breakerKey>-<isoTimestamp>   (primary, won't hit)
 *   restoreKeys: [cb-state-<breakerKey>-]                (prefix fallback)
 *
 * GitHub's cache restore falls back to the most recently created cache
 * entry matching a restoreKeys prefix, which gives us "last write wins"
 * mutable state on top of an immutable-key store, using only the default
 * GITHUB_TOKEN cache permissions — no extra scopes, no external storage,
 * no secrets to manage.
 *
 * Trade-off worth documenting for users: entries are subject to GitHub's
 * standard 7-day cache eviction on inactivity and the repo's overall
 * cache size cap. For a breaker, that's a feature, not a bug — an
 * abandoned breaker key naturally resets to Closed rather than staying
 * stuck open forever.
 */

import * as cache from "@actions/cache";
import * as core from "@actions/core";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BreakerState, initialState } from "./circuitBreaker";

const KEY_PREFIX = "cb-state-";

function stateFilePath(): string {
  return path.join(os.tmpdir(), `retry-storm-breaker-state-${Date.now()}.json`);
}

export async function loadState(breakerKey: string): Promise<BreakerState> {
  const prefix = `${KEY_PREFIX}${breakerKey}-`;
  const localFile = stateFilePath();
  const unreachablePrimaryKey = `${prefix}${new Date().toISOString()}`;

  try {
    const hit = await cache.restoreCache([localFile], unreachablePrimaryKey, [prefix]);
    if (hit && fs.existsSync(localFile)) {
      const raw = fs.readFileSync(localFile, "utf8");
      core.info(`retry-storm-breaker: restored prior state from cache key "${hit}"`);
      return JSON.parse(raw) as BreakerState;
    }
  } catch (err) {
    core.warning(
      `retry-storm-breaker: could not restore prior state (${(err as Error).message}). ` +
        `Starting from a fresh Closed circuit.`
    );
  }

  core.info("retry-storm-breaker: no prior state found, starting Closed.");
  return initialState();
}

export async function saveState(breakerKey: string, state: BreakerState): Promise<void> {
  const localFile = stateFilePath();
  fs.writeFileSync(localFile, JSON.stringify(state), "utf8");

  const saveKey = `${KEY_PREFIX}${breakerKey}-${new Date().toISOString()}`;

  try {
    await cache.saveCache([localFile], saveKey);
    core.info(`retry-storm-breaker: saved state under cache key "${saveKey}"`);
  } catch (err) {
    // Non-fatal: worst case the next run starts Closed again. We do not
    // fail the job over a persistence hiccup.
    core.warning(
      `retry-storm-breaker: could not persist state (${(err as Error).message}). ` +
        `Breaker state will not carry over to the next run.`
    );
  } finally {
    fs.rmSync(localFile, { force: true });
  }
}
