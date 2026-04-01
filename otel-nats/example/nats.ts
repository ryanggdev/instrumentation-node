/**
 * Example: OpenTelemetry tracing for NATS using @instrumentation-node/otel-nats
 *         with WebSocket bridge — forwards received messages to WS clients,
 *         propagating W3C trace context and emitting a websocket.send span.
 *
 * Prerequisites:
 *   - nats-server running on localhost:4222
 *   - Optional: Jaeger on localhost:4318 (OTLP/HTTP) for span visualization
 *   - npm install ws @types/ws   (only needed for this example)
 *
 * Run:
 *   NATS_URL=nats://localhost:4222 \
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
 *   npx tsx example/nats.ts
 *
 * Connect a WebSocket client to ws://localhost:8080 to receive forwarded messages.
 */

import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { context, propagation, trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { connect, StringCodec } from "nats";
import { WebSocketServer } from "ws";
import { natsHeaderGetter, withTracing } from "../src/index.js";

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
const WS_PORT = Number(process.env.WS_PORT ?? 8080);

// 2. Start WebSocket server.
const wss = new WebSocketServer({ port: WS_PORT });
console.log(`WebSocket server listening on ws://localhost:${WS_PORT}`);

const wsTracer = trace.getTracer("websocket-bridge");

function broadcastWithTrace(subject: string, data: string, msgHeaders: import("nats").MsgHdrs | undefined): void {
  const msgCtx = msgHeaders
    ? propagation.extract(context.active(), msgHeaders, natsHeaderGetter)
    : context.active();

  const carrier: Record<string, string> = {};
  propagation.inject(msgCtx, carrier);

  const wsSpan = wsTracer.startSpan(
    `${subject} websocket.send`,
    { kind: SpanKind.PRODUCER },
    msgCtx,
  );

  try {
    const payload = JSON.stringify({ subject, data, ...carrier });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
    wsSpan.setStatus({ code: SpanStatusCode.OK });
  } catch (err) {
    wsSpan.recordException(err as Error);
    wsSpan.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  } finally {
    wsSpan.end();
  }
}

async function main(): Promise<void> {
  console.log(`Connecting to ${NATS_URL}...`);
  const nc = await connect({ servers: NATS_URL });
  console.log(`Connected to ${nc.getServer()}`);

  // 3. Wrap the connection — all publish/subscribe/request are now traced.
  const tnc = withTracing(nc);

  // Async-iterator subscriber (CONSUMER span per message) → forward to WebSocket.
  const sub = tnc.subscribe("greet.*");
  const subDone = (async () => {
    for await (const msg of sub) {
      const text = sc.decode(msg.data);
      console.log(`[sub] ${msg.subject}: ${text} → broadcasting to WebSocket clients`);
      broadcastWithTrace(msg.subject, text, msg.headers);
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

  wss.close(() => {
    console.log("\nWebSocket server closed.");
  });

  console.log("Connection closed — check Jaeger UI at http://localhost:16686");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
