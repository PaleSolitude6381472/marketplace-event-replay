import assert from "node:assert/strict";
import test from "node:test";
import { buildReplayPlan, replayRequestSchema } from "../src/marketplace_replay.js";

test("restores marketplace state before handing an order off", () => {
  const input = replayRequestSchema.parse({
    webhook_id: "wh_marketplace",
    queue: "order-handoff",
    redrive_per_minute: 30,
    events: [
      {
        event_id: "evt-order",
        occurred_at: "2026-09-14T10:02:00.000Z",
        type: "order.ready_for_handoff",
        order_id: "ord-41",
        seller_id: "seller-8",
        buyer_id: "buyer-3",
      },
      {
        event_id: "evt-buyer",
        occurred_at: "2026-09-14T10:01:00.000Z",
        type: "buyer.profile.updated",
        buyer_id: "buyer-3",
        revision: 12,
      },
      {
        event_id: "evt-asset",
        occurred_at: "2026-09-14T10:00:00.000Z",
        type: "seller.asset.changed",
        seller_id: "seller-8",
        asset_id: "listing-90",
        version: 7,
      },
    ],
  });

  assert.deepEqual(
    buildReplayPlan(input.events).map((event) => event.event_id),
    ["evt-asset", "evt-buyer", "evt-order"],
  );
});
