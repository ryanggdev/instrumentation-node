import test from "ava";
import {
  ENV_GLOBAL_TRACING_ENABLED,
  ENV_NATS_TRACING_ENABLED,
} from "../src/env-flags.js";
import { natsTracingEnabled } from "../src/env-flags.js";

// Tests modify process.env — run serially to avoid cross-test interference.

function withEnv(
  key: string,
  value: string | undefined,
  fn: () => void,
): void {
  const prev = process.env[key];
  const existed = key in process.env;
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    if (existed && prev !== undefined) {
      process.env[key] = prev;
    } else {
      delete process.env[key];
    }
  }
}

test.serial("enabled by default when both env vars are unset", (t) => {
  withEnv(ENV_GLOBAL_TRACING_ENABLED, undefined, () => {
    withEnv(ENV_NATS_TRACING_ENABLED, undefined, () => {
      t.true(natsTracingEnabled());
    });
  });
});

test.serial("empty string is treated as enabled", (t) => {
  withEnv(ENV_NATS_TRACING_ENABLED, "", () => {
    t.true(natsTracingEnabled());
  });
});

test.serial("false tokens disable tracing", (t) => {
  for (const v of ["false", "0", "off", "no"]) {
    withEnv(ENV_NATS_TRACING_ENABLED, v, () => {
      t.false(natsTracingEnabled(), `expected disabled for value "${v}"`);
    });
  }
});

test.serial("global flag off overrides nats-specific flag on", (t) => {
  withEnv(ENV_GLOBAL_TRACING_ENABLED, "false", () => {
    withEnv(ENV_NATS_TRACING_ENABLED, "true", () => {
      t.false(
        natsTracingEnabled(),
        "expected global flag to disable nats tracing",
      );
    });
  });
});
