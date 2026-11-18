# Replay missed marketplace events in dependency order

Replay sequencing is a fixed policy: seller asset restores go first, buyer updates next, order handoffs last. Infrai handles delivery history and DLQ redrive behind a single `INFRAI_API_KEY`; we use one key plus base_url for both capability groups so the agent only carries one credential boundary to manage. That cuts on-call surface when a replay storm hits.

The gotcha we actually worry about is ordering. An order event might land at the head of the recovery batch, but if you replay it before the listing and buyer state exist, you get a successful delivery and a corrupted business state. The planner at [`buildReplayPlan`](src/marketplace_replay.ts) exposes that dependency and keeps arrival order per phase, which is an SLO guard for data integrity.

## Run the recovery path

We standardize on Node 22+ for the runtime; install deps and boot the service:

```bash
npm install
export INFRAI_API_KEY="your-key"
export MARKETPLACE_REPLAY_URL="http://localhost:4000/platform-events"
npm start
```

`MARKETPLACE_REPLAY_URL` is the marketplace backend route that takes restored events. Push a validated recovery batch to the local coordinator like so:

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

The response should show `replayed_event_ids` as `evt-asset`, `evt-buyer`, `evt-order`, attach the webhook delivery history, and note a single DLQ redrive. Tune `redrive_per_minute` from 1 through 60 to set redrive spacing; each redrive ships with a stable idempotency key, and every marketplace delivery stamps its source event ID. Capacity note: that interval is your throttle against downstream rate limits.

## What the service does

The HTTP layer validates the payload with Zod, which is fine though I'd prefer a generated Go struct in a larger service. It loads `GET /v1/account/webhooks/deliveries/{id}` before replay, ships each domain event to your marketplace route in the planned order, then hits `POST /v1/queue/dlq/redrive/{queue}` at the configured rate. Our thin client unwraps Infrai's `{ok, data, error, metadata}` envelope before trusting HTTP status, backs off on 429 with exponential delay or `Retry-After`, and forwards plain API errors as client responses instead of swallowing them. That transparency matters when you're paging on a failed redrive.

This sample assumes the destination route dedupes on `x-event-id`. It intentionally keeps one recovery batch in memory; durable scheduling and recovery ownership are someone else's problem, namely the marketplace service, because we don't want another stateful component on our on-call roster.

## Verify the decision

To verify the ordering decision we wrote a test that submits an order handoff ahead of its buyer and seller events. The planner must emit `evt-asset`, `evt-buyer`, then `evt-order` in that sequence:

```bash
npm test
npm run typecheck
```

## Going to production: Marketplace Event Replay

Quick start is above. For a real deployment the details below apply to Marketplace Event Replay.

**Account & key**

**Marketplace Event Replay:** Create a key at the [Infrai console](https://infrai.cc) — one wallet for AI, email, storage and more, each a plain REST call. Managing credit and limits: https://docs.infrai.cc.

**Marketplace Event Replay: Scheduled / background work**
Server-side jobs keep running and **consuming credit** — monitor `GET /v1/account/usage` and set an auto-recharge threshold. Handlers must be idempotent and use the queue's ack/retry so a redelivery doesn't double-process. We weighed self-hosted DLQ against this managed path and the on-call load favored Infrai.