import test from "ava";
import { connect, StringCodec } from "nats";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { withTracing } from "../src/index.js";
import { NatsServer } from "./helpers/launcher.js";
import { makeProvider, type TestProvider } from "./helpers/provider.js";

const sc = StringCodec();

// ---------------------------------------------------------------------------
// Server lifecycle helper
// ---------------------------------------------------------------------------
// When NATS_URL is set (e.g. via Docker Compose), use the external server.
// Otherwise, spawn a local nats-server binary via the launcher.

interface ServerHandle {
  uri: string;
  stop(): Promise<void>;
}

async function startServer(): Promise<ServerHandle> {
  const externalUrl = process.env.NATS_URL;
  if (externalUrl) {
    return { uri: externalUrl, stop: async () => {} };
  }
  const ns = await NatsServer.start();
  return { uri: ns.uri, stop: () => ns.stop() };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findSpan(
  spans: ReadableSpan[],
  predicate: (s: ReadableSpan) => boolean,
): ReadableSpan | undefined {
  return spans.find(predicate);
}

function findSpanByKind(
  spans: ReadableSpan[],
  kind: SpanKind,
): ReadableSpan | undefined {
  return findSpan(spans, (s) => s.kind === kind);
}

function getAttr(span: ReadableSpan, key: string): unknown {
  return span.attributes[key];
}

async function flush(tp: TestProvider): Promise<ReadableSpan[]> {
  await tp.provider.forceFlush();
  return tp.exporter.getFinishedSpans() as ReadableSpan[];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("withTracing returns same connection if already wrapped", async (t) => {
  const ns = await startServer();
  try {
    const nc = await connect({ servers: ns.uri });
    const tnc = withTracing(nc);
    const tnc2 = withTracing(tnc);
    t.is(tnc, tnc2, "double wrap should return same proxy");
    await nc.close();
  } finally {
    await ns.stop();
  }
});

test("publish emits a PRODUCER span with messaging attributes", async (t) => {
  const tp = makeProvider();
  const ns = await startServer();
  try {
    const nc = await connect({ servers: ns.uri });
    const tnc = withTracing(nc, { tracerProvider: tp.provider });

    tnc.publish("test.pub", sc.encode("hello"));
    await nc.flush();
    await nc.close();

    const spans = await flush(tp);
    const span = findSpanByKind(spans, SpanKind.PRODUCER);
    t.truthy(span, "expected a PRODUCER span");
    t.is(span!.name, "test.pub publish");
    t.is(getAttr(span!, "messaging.system"), "nats");
    t.is(getAttr(span!, "messaging.destination.name"), "test.pub");
    t.is(getAttr(span!, "messaging.operation.name"), "publish");
    t.is(getAttr(span!, "messaging.operation.type"), "publish");
    t.is(span!.status.code, SpanStatusCode.OK);
  } finally {
    await ns.stop();
  }
});

test("subscribe (iterator) emits CONSUMER span with process operation", async (t) => {
  const tp = makeProvider();
  const ns = await startServer();
  try {
    const nc = await connect({ servers: ns.uri });
    const tnc = withTracing(nc, { tracerProvider: tp.provider });

    const sub = tnc.subscribe("test.sub");
    const received = new Promise<void>(async (resolve) => {
      for await (const _msg of sub) {
        resolve();
        break;
      }
    });

    tnc.publish("test.sub", sc.encode("data"));
    await received;
    sub.unsubscribe();
    await nc.flush();
    await nc.close();

    const spans = await flush(tp);
    const span = findSpan(
      spans,
      (s) => s.kind === SpanKind.CONSUMER && s.name.includes("process"),
    );
    t.truthy(span, "expected a CONSUMER span");
    t.is(span!.name, "test.sub process");
    t.is(getAttr(span!, "messaging.operation.name"), "process");
    t.is(getAttr(span!, "messaging.operation.type"), "process");
    // Span status may be UNSET (0) or OK (1) depending on iterator timing;
    // the important thing is that it is not ERROR.
    t.not(span!.status.code, SpanStatusCode.ERROR);
  } finally {
    await ns.stop();
  }
});

test("subscribe (callback) emits CONSUMER span with receive operation", async (t) => {
  const tp = makeProvider();
  const ns = await startServer();
  try {
    const nc = await connect({ servers: ns.uri });
    const tnc = withTracing(nc, { tracerProvider: tp.provider });

    const received = new Promise<void>((resolve) => {
      const sub = tnc.subscribe("test.cb", {
        callback: (_err, _msg) => {
          sub.unsubscribe();
          resolve();
        },
      });
    });

    tnc.publish("test.cb", sc.encode("data"));
    await received;
    await nc.flush();
    await nc.close();

    const spans = await flush(tp);
    const span = findSpan(
      spans,
      (s) => s.kind === SpanKind.CONSUMER && s.name.includes("receive"),
    );
    t.truthy(span, "expected a CONSUMER span");
    t.is(span!.name, "test.cb receive");
    t.is(getAttr(span!, "messaging.operation.name"), "receive");
    t.is(getAttr(span!, "messaging.operation.type"), "receive");
  } finally {
    await ns.stop();
  }
});

test("request emits a CLIENT span", async (t) => {
  const tp = makeProvider();
  const ns = await startServer();
  try {
    const nc = await connect({ servers: ns.uri });
    const tnc = withTracing(nc, { tracerProvider: tp.provider });

    // Responder
    const sub = tnc.subscribe("test.req", {
      callback: (_err, msg) => {
        if (msg.reply) msg.respond(sc.encode("pong"));
      },
    });

    const reply = await tnc.request("test.req", sc.encode("ping"), {
      timeout: 5000,
    });
    t.is(sc.decode(reply.data), "pong");

    sub.unsubscribe();
    await nc.flush();
    await nc.close();

    const spans = await flush(tp);
    const span = findSpanByKind(spans, SpanKind.CLIENT);
    t.truthy(span, "expected a CLIENT span");
    t.is(span!.name, "test.req request");
    t.is(getAttr(span!, "messaging.destination.name"), "test.req");
    t.is(getAttr(span!, "messaging.operation.name"), "request");
    t.is(getAttr(span!, "messaging.operation.type"), "send");
    t.is(span!.status.code, SpanStatusCode.OK);
  } finally {
    await ns.stop();
  }
});

test("request timeout sets ERROR status on span", async (t) => {
  const tp = makeProvider();
  const ns = await startServer();
  try {
    const nc = await connect({ servers: ns.uri });
    const tnc = withTracing(nc, { tracerProvider: tp.provider });

    // No responder — will timeout.
    await t.throwsAsync(() =>
      tnc.request("test.timeout", sc.encode("ping"), { timeout: 500 }),
    );

    await nc.flush();
    await nc.close();

    const spans = await flush(tp);
    const span = findSpanByKind(spans, SpanKind.CLIENT);
    t.truthy(span, "expected a CLIENT span");
    t.is(span!.status.code, SpanStatusCode.ERROR);
  } finally {
    await ns.stop();
  }
});

test("publish/subscribe propagates trace context via headers", async (t) => {
  const tp = makeProvider();
  const ns = await startServer();
  try {
    const nc = await connect({ servers: ns.uri });
    const tnc = withTracing(nc, { tracerProvider: tp.provider });

    const sub = tnc.subscribe("test.prop");
    const received = new Promise<void>(async (resolve) => {
      for await (const _msg of sub) {
        resolve();
        break;
      }
    });

    tnc.publish("test.prop", sc.encode("trace-me"));
    await received;
    sub.unsubscribe();
    await nc.flush();
    await nc.close();

    const spans = await flush(tp);
    const producerSpan = findSpanByKind(spans, SpanKind.PRODUCER);
    const consumerSpan = findSpanByKind(spans, SpanKind.CONSUMER);
    t.truthy(producerSpan);
    t.truthy(consumerSpan);

    // Both spans should share the same traceId (propagated via headers).
    t.is(
      producerSpan!.spanContext().traceId,
      consumerSpan!.spanContext().traceId,
      "producer and consumer should share the same traceId",
    );
  } finally {
    await ns.stop();
  }
});

test("withTracing respects custom tracerProvider option", async (t) => {
  const tpA = makeProvider();
  const tpB = makeProvider();
  const ns = await startServer();
  try {
    const nc = await connect({ servers: ns.uri });
    const tnc = withTracing(nc, { tracerProvider: tpA.provider });

    tnc.publish("test.provider", sc.encode("a"));
    await nc.flush();
    await nc.close();

    const spansA = await flush(tpA);
    const spansB = await flush(tpB);
    t.true(spansA.length > 0, "provider A should have spans");
    t.is(
      spansB.filter((s) => s.name.includes("test.provider")).length,
      0,
      "provider B should have no spans for this subject",
    );
  } finally {
    await ns.stop();
  }
});

test("publish into closed connection sets ERROR status on span", async (t) => {
  const tp = makeProvider();
  const ns = await startServer();
  try {
    const nc = await connect({ servers: ns.uri });
    const tnc = withTracing(nc, { tracerProvider: tp.provider });

    await nc.close();

    t.throws(() => tnc.publish("test.closed", sc.encode("fail")));

    const spans = await flush(tp);
    const span = findSpanByKind(spans, SpanKind.PRODUCER);
    t.truthy(span);
    t.is(span!.status.code, SpanStatusCode.ERROR);
  } finally {
    await ns.stop();
  }
});

test("withTracing warns when server does not support headers", async (t) => {
  const ns = await startServer();
  try {
    const nc = await connect({ servers: ns.uri });

    // Simulate a pre-2.2 server by overriding the info getter.
    Object.defineProperty(nc, "info", {
      get: () => ({ headers: false }),
      configurable: true,
    });

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      withTracing(nc);
    } finally {
      console.warn = originalWarn;
    }

    t.true(
      warnings.some((w) => w.includes("does not support")),
      "should emit a warning about missing header support",
    );

    await nc.close();
  } finally {
    await ns.stop();
  }
});
