import test from "ava";
import { connect, StringCodec, AckPolicy, type NatsConnection } from "nats";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { withTracing } from "../src/index.js";
import { NatsServer } from "./helpers/launcher.js";
import { makeProvider, type TestProvider } from "./helpers/provider.js";

const sc = StringCodec();

// ---------------------------------------------------------------------------
// Server lifecycle helper
// ---------------------------------------------------------------------------

interface ServerHandle {
  uri: string;
  stop(): Promise<void>;
}

async function startServer(): Promise<ServerHandle> {
  const externalUrl = process.env.NATS_URL;
  if (externalUrl) {
    return { uri: externalUrl, stop: async () => {} };
  }
  const ns = await NatsServer.start({ jetstream: {} });
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

function getAttr(span: ReadableSpan, key: string): unknown {
  return span.attributes[key];
}

async function flush(tp: TestProvider): Promise<ReadableSpan[]> {
  await tp.provider.forceFlush();
  return tp.exporter.getFinishedSpans() as ReadableSpan[];
}

/** Create a stream via JetStream Manager for testing. */
async function ensureStream(
  nc: NatsConnection,
  stream: string,
  subjects: string[],
): Promise<void> {
  const jsm = await nc.jetstreamManager();
  try {
    await jsm.streams.info(stream);
  } catch {
    await jsm.streams.add({ name: stream, subjects });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("jetstream publish emits a PRODUCER span with JetStream attributes", async (t) => {
  const tp = makeProvider();
  const ns = await startServer();
  try {
    const nc = await connect({ servers: ns.uri });
    const tnc = withTracing(nc, { tracerProvider: tp.provider });

    await ensureStream(nc, "TEST_PUB", ["js.pub.>"]);
    const js = tnc.jetstream();

    const ack = await js.publish("js.pub.hello", sc.encode("data"));
    t.truthy(ack.stream, "should receive a PubAck with stream name");

    await nc.flush();
    await nc.close();

    const spans = await flush(tp);
    const span = findSpan(
      spans,
      (s) => s.kind === SpanKind.PRODUCER && s.name.includes("js.pub.hello"),
    );
    t.truthy(span, "expected a PRODUCER span for jetstream publish");
    t.is(span!.name, "js.pub.hello publish");
    t.is(getAttr(span!, "messaging.system"), "nats");
    t.is(getAttr(span!, "messaging.destination.name"), "js.pub.hello");
    t.is(getAttr(span!, "messaging.operation.name"), "publish");
    t.is(getAttr(span!, "messaging.operation.type"), "publish");
    t.is(getAttr(span!, "messaging.jetstream.stream"), "TEST_PUB");
    t.is(typeof getAttr(span!, "messaging.jetstream.sequence"), "number");
    t.is(span!.status.code, SpanStatusCode.OK);
  } finally {
    await ns.stop();
  }
});

test("jetstream fetch emits CONSUMER spans per message", async (t) => {
  const tp = makeProvider();
  const ns = await startServer();
  try {
    const nc = await connect({ servers: ns.uri });
    const tnc = withTracing(nc, { tracerProvider: tp.provider });

    await ensureStream(nc, "TEST_FETCH", ["js.fetch.>"]);

    // Create a durable consumer via JetStreamManager.
    const jsm = await nc.jetstreamManager();
    await jsm.consumers.add("TEST_FETCH", {
      durable_name: "test-durable",
      ack_policy: AckPolicy.Explicit,
    });

    // Publish 2 messages (through the traced connection so they get headers).
    const js = tnc.jetstream();
    await js.publish("js.fetch.a", sc.encode("one"));
    await js.publish("js.fetch.b", sc.encode("two"));

    // Fetch messages.
    const iter = js.fetch("TEST_FETCH", "test-durable", {
      batch: 2,
      expires: 5000,
    });

    const received: string[] = [];
    for await (const msg of iter) {
      received.push(sc.decode(msg.data));
      msg.ack();
      if (received.length >= 2) break;
    }

    t.is(received.length, 2);

    await nc.flush();
    await nc.close();

    const spans = await flush(tp);
    const consumerSpans = spans.filter(
      (s) =>
        s.kind === SpanKind.CONSUMER &&
        s.name.includes("process"),
    );
    t.is(consumerSpans.length, 2, "expected 2 CONSUMER spans from fetch");
    for (const span of consumerSpans) {
      t.is(getAttr(span, "messaging.system"), "nats");
      t.is(getAttr(span, "messaging.operation.type"), "process");
      t.not(span.status.code, SpanStatusCode.ERROR);
    }
  } finally {
    await ns.stop();
  }
});

test("jetstream pullSubscribe emits CONSUMER spans per message", async (t) => {
  const tp = makeProvider();
  const ns = await startServer();
  try {
    const nc = await connect({ servers: ns.uri });
    const tnc = withTracing(nc, { tracerProvider: tp.provider });

    await ensureStream(nc, "TEST_PULL", ["js.pull.>"]);

    const js = tnc.jetstream();

    // Publish a message first.
    await js.publish("js.pull.x", sc.encode("pull-me"));

    // Create a pull subscription.
    const sub = await js.pullSubscribe("js.pull.>", {
      config: {
        durable_name: "test-pull-durable",
        ack_policy: AckPolicy.Explicit,
      },
    });

    sub.pull({ batch: 1, expires: 5000 });

    const received: string[] = [];
    for await (const msg of sub) {
      received.push(sc.decode(msg.data));
      msg.ack();
      break;
    }

    t.is(received.length, 1);
    t.is(received[0], "pull-me");

    sub.unsubscribe();
    await nc.flush();
    await nc.close();

    const spans = await flush(tp);
    const span = findSpan(
      spans,
      (s) => s.kind === SpanKind.CONSUMER && s.name.includes("js.pull") && s.name.includes("process"),
    );
    t.truthy(span, "expected a CONSUMER span from pullSubscribe");
    t.is(getAttr(span!, "messaging.system"), "nats");
    t.is(getAttr(span!, "messaging.operation.name"), "process");
    t.not(span!.status.code, SpanStatusCode.ERROR);
  } finally {
    await ns.stop();
  }
});

test("jetstream publish to non-existent stream sets ERROR status", async (t) => {
  const tp = makeProvider();
  const ns = await startServer();
  try {
    const nc = await connect({ servers: ns.uri });
    const tnc = withTracing(nc, { tracerProvider: tp.provider });

    const js = tnc.jetstream();

    await t.throwsAsync(() =>
      js.publish("no.stream.here", sc.encode("fail")),
    );

    await nc.flush();
    await nc.close();

    const spans = await flush(tp);
    const span = findSpan(
      spans,
      (s) => s.kind === SpanKind.PRODUCER && s.name.includes("no.stream.here"),
    );
    t.truthy(span, "expected a PRODUCER span");
    t.is(span!.status.code, SpanStatusCode.ERROR);
  } finally {
    await ns.stop();
  }
});
