# Retry-Storm Circuit Breaker

A circuit breaker for GitHub Actions steps that **remembers failures across
workflow runs** — not just within a single job.

Every other retry action on the Marketplace forgets everything the moment
the job ends. This one doesn't. If a dependency is down, it stays tripped
across the next 50 runs until the dependency actually recovers, instead of
every single run independently retrying into the same wall.

## Why this exists

On August 17, 2026, GitHub had a ~7.5 hour outage. Mid-incident, GitHub's
own mitigation was to disable authentication-token retries, because the
retries themselves were amplifying the failure. That's the retry-storm
pattern: naive retry logic adds load to an already-struggling service,
making the outage worse and longer.

This action automates the thing GitHub's engineers had to do by hand:
stop hammering a dependency that's clearly down, and only start again once
it's shown signs of recovery.

## What makes this different

| | Typical retry actions | This action |
|---|---|---|
| Retries within a job | ✅ | ✅ |
| Jittered backoff | some | ✅ |
| **State survives across runs** | ❌ | ✅ |
| Stops hammering a dependency across many runs | ❌ | ✅ |
| Half-open recovery probing | ❌ | ✅ |

Cross-run state is the hard part — GitHub's cache API only allows writing
a given key once. This action works around that with a timestamped-key +
prefix-restore pattern, so state persists without needing any extra
permissions, secrets, or external storage. See [`src/stateStore.ts`](./src/stateStore.ts)
for the mechanism.

## Usage

```yaml
- name: Call flaky payments API
  id: breaker
  uses: kennethonyenuloya/retry-storm-breaker@v1
  with:
    key: payments-api          # stable id — same key across runs = shared state
    run: curl -sf https://payments.example.com/health
    failure-threshold: 5       # trip after 5 failures in the rolling window
    window-size: 10
    open-duration-seconds: 300 # stay open 5 minutes before probing again
    half-open-max-calls: 1
```

### Outputs

| Output | Values |
|---|---|
| `outcome` | `success`, `failure`, `circuit-open` |
| `circuit-state` | `closed`, `open`, `half-open` |
| `attempts` | number of execution attempts made |

## Getting notified — with zero code and zero liability from us

We deliberately do **not** ship Slack/Teams/Discord notifications. That
market is already well served by mature, dedicated actions, and adding
webhook/secret handling here would mean us holding liability for your
notification credentials for no real benefit over composing with what
already exists. Instead, branch off `circuit-state`:

```yaml
- name: Call flaky payments API
  id: breaker
  uses: kennethonyenuloya/retry-storm-breaker@v1
  with:
    key: payments-api
    run: curl -sf https://payments.example.com/health
  continue-on-error: true

- name: Notify Slack on trip
  if: steps.breaker.outputs.circuit-state == 'open'
  uses: rtCamp/action-slack-notify@v2
  env:
    SLACK_WEBHOOK: ${{ secrets.SLACK_WEBHOOK }}
    SLACK_MESSAGE: "Circuit breaker tripped: payments-api is down."
```

Swap in whichever notifier your team already trusts — Slack, Teams,
Discord, PagerDuty, a GitHub Issue comment. We just give you the signal.

## Observability (optional)

Set `otel-endpoint` to export an OTLP/HTTP span per invocation
(`ci.step.circuit_breaker`, with `ci.breaker.state.from/to`,
`ci.breaker.outcome`, `ci.breaker.attempts` attributes). Left empty by
default — no network calls happen unless you set it.

```yaml
    otel-endpoint: https://otel-collector.example.com
    otel-headers: |
      Authorization: Bearer ${{ secrets.OTEL_TOKEN }}
```

## Design notes / known trade-offs

- **State scope**: this wraps a single shell command/step, not an entire
  workflow. Workflow-level auto-pause is a larger blast-radius feature
  (needs `actions: write` to disable runs) and is intentionally out of
  scope here.
- **State expiry**: persisted state rides on GitHub's Actions cache, which
  evicts after 7 days of inactivity or under the repo's cache size cap.
  For a breaker, that's the right default — an abandoned key naturally
  resets to Closed rather than staying stuck open indefinitely.
- **Half-open concurrency**: if multiple jobs run in parallel against the
  same `key` while half-open, more than `half-open-max-calls` probes can
  race through before state is saved. For most CI usage (sequential
  deploy steps, scheduled health checks) this doesn't matter; for highly
  parallel matrix jobs sharing one key, be aware the probe budget is
  best-effort, not strictly atomic.

## License

MIT
