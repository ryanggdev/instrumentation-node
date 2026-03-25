# instrumentation-node

OpenTelemetry instrumentation packages for Node.js.

Each subdirectory is an independent npm package with its own `package.json`,
versioned and published independently.

## Packages

| Package | npm name | Version | Description |
|---------|----------|---------|-------------|
| `otel-nats/` | `@instrumentation-node/otel-nats` | 0.1.0 | OpenTelemetry tracing for the `nats` npm client (publish, subscribe, request-reply). |

## Usage pattern

1. Create and configure a `TracerProvider` (e.g. OTLP to Jaeger) and register it as global.
2. Set the global `TextMapPropagator` (W3C TraceContext recommended).
3. Call `withTracing(nc)` on your `NatsConnection` — all subsequent operations are traced.

See each package's `README.md` and `example/` directory for runnable examples.

## Layout

```
instrumentation-node/
├── otel-nats/          # @instrumentation-node/otel-nats
│   ├── src/
│   ├── test/
│   ├── example/
│   └── README.md
└── README.md
```

## CI

GitHub Actions runs build, typecheck, lint, and tests per package.
See [`.github/workflows/ci.yml`](.github/workflows/ci.yml).
