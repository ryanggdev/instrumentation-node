export const ENV_GLOBAL_TRACING_ENABLED =
  "OTEL_INSTRUMENTATION_NODE_TRACING_ENABLED";
export const ENV_NATS_TRACING_ENABLED = "OTEL_NATS_TRACING_ENABLED";

function envEnabledByDefault(key: string): boolean {
  const v = process.env[key];
  if (v === undefined) return true;
  switch (v.toLowerCase().trim()) {
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return true;
  }
}

export function natsTracingEnabled(): boolean {
  if (!envEnabledByDefault(ENV_GLOBAL_TRACING_ENABLED)) return false;
  return envEnabledByDefault(ENV_NATS_TRACING_ENABLED);
}
