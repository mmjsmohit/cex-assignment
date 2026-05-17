# perp-engine

Experimental in-memory perpetuals matching engine. This app is intended to maintain perpetual order books, collaterals, and positions while subscribing to external index price updates from Backpack's websocket feed.

## Current status

This service is a work in progress. The repository contains the service skeleton, market bootstrapping, Redis queue loop, and partial perpetual limit-order matching helpers, but several code paths are still marked TODO or reference functions/types that are not fully implemented yet.

## Intended responsibilities

- Load available markets from `apps/backend` at startup.
- Maintain perpetual order books by market.
- Maintain user collateral balances and locked collateral in memory.
- Maintain user perpetual positions in memory.
- Subscribe to Backpack `bookTicker` streams and update index prices.
- Process perpetual long/short order requests from Redis.
- Emit order-book updates to websocket consumers.
- Return correlated responses to backend loopback queues.

## Runtime

- Runtime: Bun
- Queue transport: Redis through Bun's `RedisClient`
- External feed: `wss://ws.backpack.exchange`
- Backend dependency: `apps/backend`

## Environment variables

- `REDIS_URL`: Redis connection string.
- `BACKEND_URL`: Backend base URL. Defaults to `http://localhost:3000`.

## Development

Install dependencies from the repository root with `bun install`, then run this app with `bun --filter perp-engine dev` or `bun run dev` from `apps/perp-engine`.

The Turborepo task config starts `backend#dev` alongside `perp-engine#dev`. Redis must also be available.

## Startup flow

1. Wait for the backend `GET /health` endpoint.
2. Fetch markets from `GET /markets`.
3. Initialize `PERP_ORDERBOOK` entries for each market.
4. Subscribe to Backpack `bookTicker.<market.name>` streams.
5. Start consuming Redis messages.

## In-memory state

- `COLLATERALS`: User collateral balances.
- `PERP_ORDERBOOK`: Per-market perpetual bids, asks, last traded price, and index price.
- `PERP_POSITIONS`: User position arrays keyed by user or market data structures.

## Consumed queues

The engine blocks on Redis with `BRPOP` against:

- `perp-incoming-orders`: Perpetual order requests.
- `collaterals`: Collateral updates and lookups.

## Published queues

- `response-queue-<queue_id>`: Sends correlated responses back to the request producer.
- `perp-order-updates`: Intended for realtime perpetual market depth updates.

## Important implementation notes

- `src/index.ts` currently calls placeholder TODO branches for perpetual market orders.
- `src/perpMatching.ts` contains copied spot-engine logic in some sections and needs cleanup before production use.
- The service should be treated as experimental until type errors and TODOs are resolved.
## TODOs

-
