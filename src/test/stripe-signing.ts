import { createHmac, randomUUID } from "node:crypto";

/** Webhook payloads are triggers only; tests may put anything in the object. */
export type StripeEventObject = Record<string, unknown>;

export function stripeSignatureHeader(input: {
  payload: string;
  secret: string;
  timestampSeconds?: number;
}): string {
  const timestamp = input.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", input.secret)
    .update(`${timestamp}.${input.payload}`)
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

export function stripeEventPayload(input: {
  id: string;
  type: string;
  object: StripeEventObject;
}): string {
  return JSON.stringify({
    id: input.id,
    object: "event",
    created: Math.floor(Date.now() / 1000),
    type: input.type,
    data: { object: input.object },
  });
}

export function uniqueStripeEventId(): string {
  return `evt_${randomUUID().replace(/-/g, "")}`;
}
