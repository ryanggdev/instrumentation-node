import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { propagation } from "@opentelemetry/api";

// Set W3C propagator globally for all tests.
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

export interface TestProvider {
  exporter: InMemorySpanExporter;
  provider: BasicTracerProvider;
}

/**
 * Creates a fresh InMemorySpanExporter + BasicTracerProvider per test.
 * The provider is registered as global so the `withTracing` default path works.
 */
export function makeProvider(): TestProvider {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
  return { exporter, provider };
}
