import { z } from "zod";
import { InfraiClient } from "./infrai_client.js";

const common = {
  event_id: z.string().min(1),
  occurred_at: z.string().datetime(),
};

export const replayRequestSchema = z.object({
  webhook_id: z.string().min(1),
  queue: z.string().min(1),
  redrive_per_minute: z.number().int().min(1).max(60),
  redrive_count: z.number().int().min(1).max(20).default(1),
  events: z.array(z.discriminatedUnion("type", [
    z.object({
      ...common,
      type: z.literal("seller.asset.changed"),
      seller_id: z.string().min(1),
      asset_id: z.string().min(1),
      version: z.number().int().positive(),
    }),
    z.object({
      ...common,
      type: z.literal("buyer.profile.updated"),
      buyer_id: z.string().min(1),
      revision: z.number().int().positive(),
    }),
    z.object({
      ...common,
      type: z.literal("order.ready_for_handoff"),
      order_id: z.string().min(1),
      seller_id: z.string().min(1),
      buyer_id: z.string().min(1),
    }),
  ])).min(1),
});

export type ReplayRequest = z.infer<typeof replayRequestSchema>;
export type MarketplaceEvent = ReplayRequest["events"][number];

const phase: Record<MarketplaceEvent["type"], number> = {
  "seller.asset.changed": 0,
  "buyer.profile.updated": 1,
  "order.ready_for_handoff": 2,
};

export function buildReplayPlan(events: MarketplaceEvent[]): MarketplaceEvent[] {
  return events
    .map((event, inputIndex) => ({ event, inputIndex }))
    .sort((left, right) => phase[left.event.type] - phase[right.event.type] || left.inputIndex - right.inputIndex)
    .map(({ event }) => event);
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function replayMarketplace(
  input: ReplayRequest,
  infrai: InfraiClient,
  destination: string,
  deliver: typeof fetch = fetch,
) {
  const deliveryHistory = await infrai.deliveryHistory(input.webhook_id);
  const plan = buildReplayPlan(input.events);

  for (const event of plan) {
    const response = await deliver(destination, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-event-id": event.event_id,
      },
      body: JSON.stringify(event),
    });
    if (!response.ok) throw new Error(`Marketplace rejected ${event.event_id} (${response.status})`);
  }

  const interval = 60_000 / input.redrive_per_minute;
  for (let index = 0; index < input.redrive_count; index += 1) {
    await infrai.redrive(input.queue, `marketplace-redrive:${input.webhook_id}:${index}`);
    if (index + 1 < input.redrive_count) await sleep(interval);
  }

  return {
    replayed_event_ids: plan.map((event) => event.event_id),
    phases: plan.map((event) => event.type),
    delivery_history: deliveryHistory,
    dlq_redrives: input.redrive_count,
  };
}
