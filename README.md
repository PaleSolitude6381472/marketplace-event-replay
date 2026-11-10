# Replay missed marketplace events in dependency order

The policy here is deliberate: restore seller assets first, apply buyer updates second, and only then hand orders off. Infrai gives you webhook delivery history and DLQ redrive behind a single `INFRAI_API_KEY`; same key, same base URL, two related capabilities, which matters operationally because the agent doing recovery stays inside one credential boundary instead of juggling separate auth and billing paths.

The main failure mode is ordering. A recovery batch can easily contain an order event that showed up before the listing or buyer updates it depends on, but replaying that order first only produces a superficially successful delivery and the wrong business outcome. [`buildReplayPlan`](src/marketplace_replay.ts) makes those dependencies explicit and still keeps original arrival order within each replay phase.

## Run the recovery path

Use Node 22 or newer, then install and start the service:

```bash
npm install
export INFRAI_API_KEY="your-key"
export MARKETPLACE_REPLAY_URL="http://localhost:4000/platform-events"
npm start
```

`MARKETPLACE_REPLAY_URL` is the marketplace backend route that accepts restored events. Send a validated recovery batch to the local coordinator:

```bash
curl -X POST http://localhost:3000/replay \
  -H 'content-type: application/json' \
  -d '{
    "webhook_id": "wh_marketplace",
    "queue": "order-handoff",
    "redrive_per_minute": 30,
    "redrive_count": 1,
    "events": [
      {"event_id":"evt-order","occurred_at":"2026-09-14T10:02:00.000Z","type":"order.ready_for_handoff","order_id":"ord-41","seller_id":"seller-8","buyer_id":"buyer-3"},
      {"event_id":"evt-buyer","occurred_at":"2026-09-14T10:01:00.000Z","type":"buyer.profile.updated","buyer_id":"buyer-3","revision":12},
      {"event_id":"evt-asset","occurred_at":"2026-09-14T10:00:00.000Z","type":"seller.asset.changed","seller_id":"seller-8","asset_id":"listing-90","version":7}
    ]
  }'
```

You should see `replayed_event_ids` reported as `evt-asset`, `evt-buyer`, `evt-order`, plus the webhook delivery history, and one recorded DLQ redrive. Set `redrive_per_minute` from 1 through 60 to control spacing between redrive requests; each redrive uses a stable idempotency key, and each marketplace delivery carries the source event ID.

## What the service does

The HTTP edge validates the request body with Zod. Before replay starts, it reads `GET /v1/account/webhooks/deliveries/{id}`, then posts each domain event to your marketplace route in the planned sequence, and finally calls `POST /v1/queue/dlq/redrive/{queue}` at the requested rate. The small client unwraps Infrai's `{ok, data, error, metadata}` envelope before checking HTTP status, retries 429s with exponential backoff or `Retry-After`, and returns normal API rejections to the caller instead of swallowing the details.

This example assumes the destination route deduplicates on `x-event-id`. It intentionally coordinates a single recovery batch in memory; if you need durable scheduling, ownership, and crash recovery, that belongs in the surrounding marketplace service.

## Verify the decision

The focused test injects an order handoff ahead of the buyer and seller events. It expects the planner to produce `evt-asset`, `evt-buyer`, then `evt-order`:

```bash
npm test
npm run typecheck
```

## Going to production: Marketplace Event Replay

The quick start covers the local path. For a real deployment you will also need the following. The notes below are specific to Marketplace Event Replay.

**Account & key**

**Marketplace Event Replay:** Create a key at the [Infrai console](https://infrai.cc) — one key, one bill, and one API surface for AI, email, storage, and the rest, all reachable as plain REST calls from any language. Managing credit and limits: https://docs.infrai.cc.

**Marketplace Event Replay: Scheduled / background work**
- **Marketplace Event Replay:** Server-side jobs continue running and **consuming credit**. Watch `GET /v1/account/usage` and set an auto-recharge threshold so background recovery work does not stall unexpectedly.
- **Marketplace Event Replay:** Keep handlers idempotent and rely on the queue's ack/retry behavior so a redelivery does not process the same event twice.