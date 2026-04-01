export { withTracing } from "./tracing.ts";
export type { TracingOptions } from "./tracing.ts";
export {
  NatsHeaderCarrier,
  natsHeaderGetter,
  natsHeaderSetter,
} from "./propagation.ts";
export {
  INSTRUMENTATION_NAME,
  INSTRUMENTATION_VERSION,
} from "./version.ts";
