import { redis } from "bun";

interface WebSocketData {
  marketId: string;
  connectedAt: number;
}

async function* listenToOrderUpdates() {
  while (true) {
    try {
      const result = await redis.brpop("order-updates", 0);
      if (!result || result[1] == null) {
        console.warn("brpop returned null, retrying...");
        continue;
      }
      console.log(
        `WS rcvd an order update on process ${process.pid}: `,
        result,
      );
      const parsedResult = JSON.parse(result[1]);
      yield parsedResult;
    } catch (err) {
      console.error("Redis listener error:", err);
    }
  }
}

const server = Bun.serve<WebSocketData>({
  port: 4000,
  fetch(req, server) {
    const url = new URL(req.url);
    const marketId = url.searchParams.get("marketId");

    // Pass the market (or the whole req info) into the data object
    if (marketId) {
      const upgraded = server.upgrade(req, {
        data: {
          marketId: marketId,
          connectedAt: Date.now(),
        },
      });
      if (upgraded) return;
    }
    return new Response("Upgrade Failed", { status: 500 });
  },
  websocket: {
    async open(ws) {
      // Get the user's market from the query string
      const { marketId } = ws.data;
      // When a connection is opened, map the ws to the market and store it
      console.log(`Connected to ${marketId}`);
      ws.subscribe(marketId);

      // Send the user the current depth of the market when they connect initially
      const depth = await fetch(`${process.env.BACKEND_URL}/depth/${marketId}`);
      const depthData = await depth.json();
      console.log("here");
      ws.send(JSON.stringify(depthData));
    },
    message(ws, message) {
      console.log(message);
    },
    close(ws, code, reason) {
      console.log(
        `Disconnected: ${code} ${reason} from the market ${ws.data.marketId}`,
      );
    },
  },
});

console.log(`Server listening on ${server.port}`);

(async () => {
  for await (const update of listenToOrderUpdates()) {
    // Send the updated depth to EVERY client subscribed to received marketId
    server.publish(update.marketId, JSON.stringify(update));
    console.log(
      `Sent update to ${update.marketId} with data ${JSON.stringify(update)}`,
    );
  }
})();
