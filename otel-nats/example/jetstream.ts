/**
 * Example: OpenTelemetry tracing for NATS JetStream
 *
 * Prerequisites:
 *   - nats-server running on localhost:4222 with JetStream enabled
 *   - Optional: Jaeger on localhost:4318 (OTLP/HTTP) for span visualization
 *
 * Run:
 *   NATS_URL=nats://localhost:4222 \
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
 *   npx tsx example/jetstream.ts
 */

import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { propagation } from "@opentelemetry/api";
import { connect, StringCodec, AckPolicy } from "nats";
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

  // 2. Wrap the connection — jetstream() now returns a traced JetStreamClient.
  const tnc = withTracing(nc);

  // 3. Set up stream and consumer via JetStreamManager.
  const jsm = await nc.jetstreamManager();
  const streamName = "EXAMPLE";
  const subjects = ["example.>"];

  try {
    await jsm.streams.info(streamName);
    // Purge leftover messages from previous runs.
    await jsm.streams.purge(streamName);
  } catch {
    await jsm.streams.add({ name: streamName, subjects });
  }
  console.log(`Stream "${streamName}" ready (subjects: ${subjects})`);

  const js = tnc.jetstream();

  // ── JetStream Publish (PRODUCER spans) ──────────────────────────────────
  const ack1 = await js.publish("example.orders", sc.encode("order-1"));
  console.log(`[js.publish] example.orders → stream=${ack1.stream} seq=${ack1.seq}`);

  const ack2 = await js.publish("example.orders", sc.encode("order-2"));
  console.log(`[js.publish] example.orders → stream=${ack2.stream} seq=${ack2.seq}`);

  const ack3 = await js.publish("example.events", sc.encode("event-1"));
  console.log(`[js.publish] example.events → stream=${ack3.stream} seq=${ack3.seq}`);

  // ── JetStream Fetch (CONSUMER spans per message) ────────────────────────
  console.log("\n--- fetch ---");
  await jsm.consumers.add(streamName, {
    durable_name: "fetch-demo",
    ack_policy: AckPolicy.Explicit,
    filter_subject: "example.orders",
  });

  const iter = js.fetch(streamName, "fetch-demo", { batch: 2, expires: 5000 });
  for await (const msg of iter) {
    console.log(`[js.fetch] ${msg.subject}: ${sc.decode(msg.data)}`);
    msg.ack();
  }

  // ── JetStream PullSubscribe (CONSUMER spans per message) ────────────────
  console.log("\n--- pullSubscribe ---");
  const sub = await js.pullSubscribe("example.events", {
    config: {
      durable_name: "pull-demo",
      ack_policy: AckPolicy.Explicit,
    },
  });

  sub.pull({ batch: 1, expires: 5000 });
  for await (const msg of sub) {
    console.log(`[js.pullSubscribe] ${msg.subject}: ${sc.decode(msg.data)}`);
    msg.ack();
    break;
  }
  sub.unsubscribe();

  // 4. Clean up.
  await nc.flush();
  await nc.close();
  await provider.forceFlush();
  console.log("\nConnection closed — check Jaeger UI at http://localhost:16686");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
