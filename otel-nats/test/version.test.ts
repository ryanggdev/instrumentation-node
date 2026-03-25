import test from "ava";
import {
  INSTRUMENTATION_NAME,
  INSTRUMENTATION_VERSION,
} from "../src/version.js";

test("INSTRUMENTATION_NAME matches expected scope name", (t) => {
  t.is(
    INSTRUMENTATION_NAME,
    "github.com/ryanggdev/instrumentation-node/otel-nats",
  );
});

test("INSTRUMENTATION_VERSION matches package version", (t) => {
  t.is(INSTRUMENTATION_VERSION, "0.1.0");
});
