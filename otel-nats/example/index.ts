/**
 * Example: OpenTelemetry tracing for NATS using @instrumentation-node/otel-nats
 *
 * Prerequisites:
 *   - nats-server running on localhost:4222
 *   - Optional: Jaeger on localhost:4318 (OTLP/HTTP) for span visualization
 *
 * Run:
 *   # Spans exported to Jaeger (or any OTLP-compatible backend):
 *   NATS_URL=nats://localhost:4222 \
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
 *   npx tsx example/index.ts
 *
 *   # Without an exporter endpoint, spans are silently discarded:
 *   NATS_URL=nats://localhost:4222 npx tsx example/index.ts
 */

import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { propagation } from "@opentelemetry/api";
import { connect, StringCodec } from "nats";
import { withTracing } from "../src/index.js";

// 1. Initialize OTel SDK.
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const spanProcessors = endpoint
  ? [new SimpleSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }))]
  : [];

if (!endpoint) {
  console.log("No OTEL_EXPORTER_OTLP_ENDPOINT set — spans will be discarded.");
}

const provider = new BasicTracerProvider({ spanProcessors });
provider.register();

const sc = StringCodec();
const NATS_URL = process.env.NATS_URL ?? "nats://127.0.0.1:4222";

async function main(): Promise<void> {
  console.log(`Connecting to ${NATS_URL}...`);
  const nc = await connect({ servers: NATS_URL });
  console.log(`Connected to ${nc.getServer()}`);

  // 2. Wrap the connection — all publish/subscribe/request are now traced.
  const tnc = withTracing(nc);

  // Async-iterator subscriber (CONSUMER span per message).
  const sub = tnc.subscribe("greet.*");
  const subDone = (async () => {
    for await (const msg of sub) {
      console.log(`[sub] ${msg.subject}: ${sc.decode(msg.data)}`);
    }
  })();

  // Publish (PRODUCER spans).
  tnc.publish("greet.world", sc.encode("hello"));
  tnc.publish("greet.nats", sc.encode("world"));

  // Request-reply: CLIENT span covers the full round-trip.
  const echoSub = tnc.subscribe("echo", {
    callback: (_err, msg) => {
      if (msg.reply) msg.respond(msg.data);
    },
  });

  try {
    const reply = await tnc.request("echo", sc.encode("ping"), {
      timeout: 3000,
    });
    console.log(`[req] reply: ${sc.decode(reply.data)}`);
  } catch (err) {
    console.error("[req] error:", (err as Error).message);
  }

  await nc.flush();
  sub.unsubscribe();
  echoSub.unsubscribe();
  await subDone;
  await nc.close();

  await provider.forceFlush();
  console.log("Connection closed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
