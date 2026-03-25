import test from "ava";
import { headers } from "nats";
import { NatsHeaderCarrier, natsHeaderGetter, natsHeaderSetter } from "../src/propagation.js";

test("set and get round-trips a header value", (t) => {
  const hdrs = headers();
  const carrier = new NatsHeaderCarrier();
  carrier.set(hdrs, "traceparent", "00-abc-def-01");
  t.is(carrier.get(hdrs, "traceparent"), "00-abc-def-01");
});

test("get returns undefined for missing key", (t) => {
  const hdrs = headers();
  const carrier = new NatsHeaderCarrier();
  t.is(carrier.get(hdrs, "nonexistent"), undefined);
});

test("keys returns all set keys", (t) => {
  const hdrs = headers();
  const carrier = new NatsHeaderCarrier();
  carrier.set(hdrs, "traceparent", "val1");
  carrier.set(hdrs, "tracestate", "val2");
  const keys = carrier.keys(hdrs);
  t.true(keys.includes("traceparent"));
  t.true(keys.includes("tracestate"));
});

test("forHeaders creates new MsgHdrs when none given", (t) => {
  const { carrier, hdrs } = NatsHeaderCarrier.forHeaders();
  t.truthy(hdrs);
  carrier.set(hdrs, "key", "value");
  t.is(carrier.get(hdrs, "key"), "value");
});

test("forHeaders reuses provided MsgHdrs", (t) => {
  const existing = headers();
  existing.set("pre-existing", "yes");
  const { carrier, hdrs } = NatsHeaderCarrier.forHeaders(existing);
  t.is(hdrs, existing);
  t.is(carrier.get(hdrs, "pre-existing"), "yes");
});

test("singleton getter and setter work correctly", (t) => {
  const hdrs = headers();
  natsHeaderSetter.set(hdrs, "test-key", "test-val");
  t.is(natsHeaderGetter.get(hdrs, "test-key"), "test-val");
});
