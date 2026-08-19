/**
 * Optional OpenTelemetry span emission via raw OTLP/HTTP JSON.
 *
 * Deliberately NOT using the full OTel JS SDK — it's a heavy dependency
 * for a single-span emission and would bloat the bundled Action. This
 * posts a minimally valid OTLP ExportTraceServiceRequest directly.
 * Only runs if the user supplies `otel-endpoint`; silently skipped
 * otherwise so this stays zero-config by default.
 */

import * as core from "@actions/core";
import { HttpClient } from "@actions/http-client";
import { CircuitState } from "./circuitBreaker";

export interface SpanInput {
  endpoint: string;
  headers: Record<string, string>;
  breakerKey: string;
  fromState: CircuitState;
  toState: CircuitState;
  outcome: "success" | "failure" | "circuit-open";
  attempts: number;
  startTimeMs: number;
  endTimeMs: number;
}

export async function emitSpan(input: SpanInput): Promise<void> {
  const client = new HttpClient("retry-storm-breaker");

  const spanIdBytes = randomHex(8);
  const traceIdBytes = randomHex(16);

  const body = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            attr("service.name", "retry-storm-breaker"),
            attr("ci.breaker.key", input.breakerKey),
          ],
        },
        scopeSpans: [
          {
            scope: { name: "retry-storm-breaker" },
            spans: [
              {
                traceId: traceIdBytes,
                spanId: spanIdBytes,
                name: "ci.step.circuit_breaker",
                startTimeUnixNano: String(input.startTimeMs * 1_000_000),
                endTimeUnixNano: String(input.endTimeMs * 1_000_000),
                attributes: [
                  attr("ci.breaker.state.from", input.fromState),
                  attr("ci.breaker.state.to", input.toState),
                  attr("ci.breaker.outcome", input.outcome),
                  attr("ci.breaker.attempts", String(input.attempts)),
                ],
                status: {
                  code: input.outcome === "success" ? 1 : 2,
                },
              },
            ],
          },
        ],
      },
    ],
  };

  try {
    const res = await client.postJson(
      input.endpoint.replace(/\/$/, "") + "/v1/traces",
      body,
      input.headers
    );
    if (res.statusCode >= 300) {
      core.warning(`retry-storm-breaker: OTel export returned HTTP ${res.statusCode}`);
    }
  } catch (err) {
    core.warning(`retry-storm-breaker: OTel export failed (${(err as Error).message})`);
  }
}

function attr(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  return Buffer.from(arr).toString("hex");
}
