import type { TextMapGetter, TextMapSetter } from "@opentelemetry/api";
import type { MsgHdrs } from "nats";
import { headers } from "nats";

/**
 * NatsHeaderCarrier adapts a NATS MsgHdrs object to the OTel
 * TextMapGetter / TextMapSetter interfaces, enabling W3C TraceContext
 * inject/extract via NATS message headers.
 *
 * Mirrors otelnats.HeaderCarrier from instrumentation-go.
 */
export class NatsHeaderCarrier
  implements TextMapGetter<MsgHdrs>, TextMapSetter<MsgHdrs>
{
  /**
   * Creates a NatsHeaderCarrier wrapping existing headers, or a fresh
   * MsgHdrs instance when none are provided.
   */
  static forHeaders(existing?: MsgHdrs): {
    carrier: NatsHeaderCarrier;
    hdrs: MsgHdrs;
  } {
    const hdrs = existing ?? headers();
    return { carrier: new NatsHeaderCarrier(), hdrs };
  }

  get(carrier: MsgHdrs, key: string): string | undefined {
    const v = carrier.get(key);
    // MsgHdrs.get() returns "" for missing keys; normalise to undefined.
    return v === "" ? undefined : v;
  }

  keys(carrier: MsgHdrs): string[] {
    return carrier.keys();
  }

  set(carrier: MsgHdrs, key: string, value: string): void {
    carrier.set(key, value);
  }
}

/**
 * Module-level singleton instances. Using singletons (rather than creating
 * new instances per call) matches the nats.node pattern and avoids allocation
 * on every message.
 */
export const natsHeaderSetter: TextMapSetter<MsgHdrs> =
  new NatsHeaderCarrier();
export const natsHeaderGetter: TextMapGetter<MsgHdrs> =
  new NatsHeaderCarrier();
