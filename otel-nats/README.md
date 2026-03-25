# @instrumentation-node/otel-nats

OpenTelemetry tracing for the [`nats`](https://www.npmjs.com/package/nats) npm package.
Propagates W3C Trace Context via NATS message headers. Modeled on
[instrumentation-go/otel-nats](https://github.com/ryanggdev/instrumentation-go/tree/main/otel-nats).

## Install

```bash
npm install @instrumentation-node/otel-nats
# peer dependencies (if not already installed)
npm install nats @opentelemetry/api
```

## Usage

```ts
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { propagation } from "@opentelemetry/api";
import { connect } from "nats";
import { withTracing } from "@instrumentation-node/otel-nats";

// 1. Initialize OTel SDK before any NATS code.
const provider = new BasicTracerProvider({ /* spanProcessors: [...] */ });
provider.register();
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

// 2. Connect to NATS and wrap the connection.
const nc = await connect({ servers: "localhost:4222" });
const tnc = withTracing(nc);

// 3. Use tnc like a regular NatsConnection — spans are emitted automatically.
tnc.publish("orders.created", payload);

const sub = tnc.subscribe("orders.*");
for await (const msg of sub) { /* CONSUMER span per message */ }

const reply = await tnc.request("rpc.service", payload, { timeout: 3000 });
```

## TracingOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `tracerProvider` | `TracerProvider` | global provider | TracerProvider to use when creating the tracer. Preferred over `tracer`. |
| `tracer` | `Tracer` | — | Pre-built tracer; overrides `tracerProvider` when supplied. |
| `instrumentationName` | `string` | `"github.com/ryanggdev/instrumentation-node/otel-nats"` | OTel scope name. |
| `instrumentationVersion` | `string` | `"0.1.0"` | OTel scope version. |

## Span model

| Operation | Span kind | `messaging.operation.name` | Context |
|-----------|-----------|---------------------------|---------|
| `publish` | PRODUCER | `"publish"` | Injects into headers |
| `subscribe` (iterator) | CONSUMER | `"process"` | Extracts from headers |
| `subscribe` (callback) | CONSUMER | `"receive"` | Extracts from headers |
| `request` | CLIENT | `"request"` | Injects into headers |

Requires NATS Server v2.2+ for message header support.

## Layout

```
otel-nats/
├── src/
│   ├── index.ts         # Public exports
│   ├── propagation.ts   # NatsHeaderCarrier (TextMapGetter + TextMapSetter)
│   ├── tracing.ts       # withTracing, TracingOptions
│   └── version.ts       # INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION
├── test/
│   ├── helpers/
│   │   ├── launcher.ts  # NatsServer (spawns nats-server binary)
│   │   └── provider.ts  # makeProvider() for tests
│   ├── propagation.test.ts
│   ├── tracing.test.ts
│   └── version.test.ts
├── example/
│   └── index.ts
├── package.json
└── tsconfig.json
```

## Dependencies

- **Peer**: `nats ^2.13.0`, `@opentelemetry/api ^1.0.0`
- **Node**: >=18.0.0
