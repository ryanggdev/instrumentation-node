import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import type { Span, Tracer, TracerProvider } from "@opentelemetry/api";
import type {
  Msg,
  MsgHdrs,
  NatsConnection,
  PublishOptions,
  RequestOptions,
  Subscription,
  SubscriptionOptions,
} from "nats";
import { headers } from "nats";

import { natsHeaderGetter, natsHeaderSetter } from "./propagation.js";
import { INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION } from "./version.js";

// ---------------------------------------------------------------------------
// Public options type
// ---------------------------------------------------------------------------

export interface TracingOptions {
  /**
   * A TracerProvider to use when creating the tracer.
   * Defaults to the global TracerProvider via `trace.getTracerProvider()`.
   * Prefer passing a provider over a pre-built tracer so the OTel SDK
   * controls tracer lifecycle (follows OTel Go Contrib guideline).
   */
  tracerProvider?: TracerProvider;
  /**
   * A pre-built Tracer. When supplied, overrides `tracerProvider`.
   * Use when you need precise tracer control in tests.
   */
  tracer?: Tracer;
  /**
   * Instrumentation scope name reported to the OTel SDK.
   * Defaults to the package's canonical name.
   */
  instrumentationName?: string;
  /**
   * Instrumentation scope version reported to the OTel SDK.
   * Defaults to the package version.
   */
  instrumentationVersion?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Symbol used to mark already-wrapped connections (prevents double-wrapping). */
const TRACING_SYMBOL = Symbol("@instrumentation-node/otel-nats.tracing");

function resolveTracer(opts: TracingOptions): Tracer {
  if (opts.tracer) return opts.tracer;
  const name = opts.instrumentationName ?? INSTRUMENTATION_NAME;
  const version = opts.instrumentationVersion ?? INSTRUMENTATION_VERSION;
  const provider = opts.tracerProvider ?? trace.getTracerProvider();
  return provider.getTracer(name, version);
}

function injectContext(
  existingHdrs: MsgHdrs | undefined,
  span: Span,
): MsgHdrs {
  const hdrs = existingHdrs ?? headers();
  propagation.inject(
    trace.setSpan(context.active(), span),
    hdrs,
    natsHeaderSetter,
  );
  return hdrs;
}

function extractContext(msg: Msg) {
  if (msg.headers) {
    return propagation.extract(
      context.active(),
      msg.headers,
      natsHeaderGetter,
    );
  }
  return context.active();
}

function startMessagingSpan(
  tracer: Tracer,
  subject: string,
  operation: string,
  kind: SpanKind,
  operationType: string,
  parentCtx = context.active(),
): Span {
  return tracer.startSpan(
    `${subject} ${operation}`,
    {
      kind,
      attributes: {
        "messaging.system": "nats",
        "messaging.destination.name": subject,
        "messaging.operation.name": operation,
        "messaging.operation.type": operationType,
      },
    },
    parentCtx,
  );
}

// ---------------------------------------------------------------------------
// Subscription wrapper (iterator path)
// ---------------------------------------------------------------------------

function wrapSubscription(
  sub: Subscription,
  tracer: Tracer,
  subject: string,
): Subscription {
  return new Proxy(sub, {
    get(target: Subscription, prop: PropertyKey, receiver: unknown) {
      if (prop === Symbol.asyncIterator) {
        return async function* () {
          for await (const msg of target) {
            const parentCtx = extractContext(msg);
            const span = startMessagingSpan(
              tracer,
              subject,
              "process",
              SpanKind.CONSUMER,
              "process",
              parentCtx,
            );
            try {
              yield await context.with(
                trace.setSpan(parentCtx, span),
                () => Promise.resolve(msg),
              );
              span.setStatus({ code: SpanStatusCode.OK });
            } catch (err) {
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: err instanceof Error ? err.message : String(err),
              });
              span.recordException(err as Error);
              throw err;
            } finally {
              span.end();
            }
          }
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Subscription;
}

// ---------------------------------------------------------------------------
// NatsConnection operation wrappers
// ---------------------------------------------------------------------------

function tracedPublish(
  nc: NatsConnection,
  tracer: Tracer,
): (subject: string, payload?: Uint8Array, options?: PublishOptions) => void {
  return (subject, payload, options) => {
    const span = startMessagingSpan(
      tracer,
      subject,
      "publish",
      SpanKind.PRODUCER,
      "publish",
    );
    try {
      const hdrs = injectContext(options?.headers, span);
      nc.publish(subject, payload, { ...options, headers: hdrs });
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  };
}

function tracedSubscribe(
  nc: NatsConnection,
  tracer: Tracer,
): (subject: string, opts?: SubscriptionOptions) => Subscription {
  return (subject, opts) => {
    if (opts?.callback) {
      const originalCallback = opts.callback;
      const wrappedOpts: SubscriptionOptions = {
        ...opts,
        callback: (err, msg) => {
          if (err) {
            originalCallback(err, msg);
            return;
          }
          const parentCtx = extractContext(msg);
          const span = startMessagingSpan(
            tracer,
            subject,
            "receive",
            SpanKind.CONSUMER,
            "receive",
            parentCtx,
          );
          context.with(trace.setSpan(parentCtx, span), () => {
            try {
              originalCallback(err, msg);
              span.setStatus({ code: SpanStatusCode.OK });
            } catch (cbErr) {
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message:
                  cbErr instanceof Error ? cbErr.message : String(cbErr),
              });
              span.recordException(cbErr as Error);
              throw cbErr;
            } finally {
              span.end();
            }
          });
        },
      };
      return wrapSubscription(
        nc.subscribe(subject, wrappedOpts),
        tracer,
        subject,
      );
    }
    return wrapSubscription(nc.subscribe(subject, opts), tracer, subject);
  };
}

function tracedRequest(
  nc: NatsConnection,
  tracer: Tracer,
): (
  subject: string,
  payload?: Uint8Array,
  opts?: RequestOptions,
) => Promise<Msg> {
  return async (subject, payload, opts) => {
    const span = startMessagingSpan(
      tracer,
      subject,
      "request",
      SpanKind.CLIENT,
      "send",
    );
    try {
      const hdrs = injectContext(opts?.headers, span);
      const response = await context.with(
        trace.setSpan(context.active(), span),
        () =>
          nc.request(subject, payload, {
            ...opts,
            headers: hdrs,
          } as RequestOptions),
      );
      span.setStatus({ code: SpanStatusCode.OK });
      return response;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  };
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Wraps an existing NatsConnection with OpenTelemetry tracing.
 *
 * Publish, subscribe, and request/reply operations emit spans and propagate
 * W3C TraceContext via NATS message headers. Requires NATS Server v2.2+ for
 * header support.
 *
 * @example
 * ```ts
 * import { connect } from "nats";
 * import { withTracing } from "@instrumentation-node/otel-nats";
 *
 * const nc = await connect({ servers: "localhost:4222" });
 * const tnc = withTracing(nc);
 * tnc.publish("orders.created", data);
 * ```
 */
export function withTracing(
  nc: NatsConnection,
  opts: TracingOptions = {},
): NatsConnection {
  if ((nc as unknown as Record<symbol, boolean>)[TRACING_SYMBOL]) {
    return nc; // already wrapped — prevent double instrumentation
  }

  const tracer = resolveTracer(opts);

  // Warn when server doesn't support headers (pre-NATS 2.2)
  const serverInfo = (nc as unknown as { info?: { headers?: boolean } }).info;
  if (serverInfo && serverInfo.headers === false) {
    console.warn(
      "[@instrumentation-node/otel-nats] Connected NATS server does not support " +
        "message headers. Trace context will not propagate. Upgrade to NATS Server v2.2+.",
    );
  }

  return new Proxy(nc, {
    get(target: NatsConnection, prop: PropertyKey, receiver: unknown) {
      switch (prop) {
        case TRACING_SYMBOL:
          return true;
        case "publish":
          return tracedPublish(target, tracer);
        case "subscribe":
          return tracedSubscribe(target, tracer);
        case "request":
          return tracedRequest(target, tracer);
        default:
          return Reflect.get(target, prop, receiver);
      }
    },
  }) as NatsConnection;
}
