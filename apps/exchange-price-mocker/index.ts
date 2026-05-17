import type { ServerWebSocket } from "bun";

type PriceUpdateRequest = {
  price: number | string;
  marketId: string;
};

type SubscriptionRequest = {
  method?: string;
  params?: string[];
};

type WebSocketData = {
  subscribedStreams: Set<string>;
};

const port = Number(process.env.PORT ?? 6000);
const connectedClients = new Set<ServerWebSocket<WebSocketData>>();

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
}

function isValidPriceUpdate(body: Partial<PriceUpdateRequest>) {
  return (
    typeof body.marketId === "string" &&
    body.marketId.trim().length > 0 &&
    (typeof body.price === "number" || typeof body.price === "string") &&
    Number.isFinite(Number(body.price))
  );
}

const server = Bun.serve<WebSocketData>({
  port,
  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return jsonResponse({
        status: "ok",
        websocket: true,
        connectedClients: connectedClients.size,
      });
    }

    if (url.pathname === "/") {
      const upgraded = server.upgrade(req, {
        data: { subscribedStreams: new Set<string>() },
      });

      if (upgraded) return;

      return jsonResponse(
        { error: "Expected a websocket upgrade request" },
        { status: 400 },
      );
    }

    if (url.pathname === "/forward-price" && req.method === "POST") {
      return handleForwardPrice(req);
    }

    return jsonResponse({ error: "Not found" }, { status: 404 });
  },
  websocket: {
    open(ws) {
      connectedClients.add(ws);
      ws.send(
        JSON.stringify({
          type: "connected",
          message: "exchange-price-mocker is ready for subscriptions",
        }),
      );
    },
    message(ws, message) {
      try {
        const parsedMessage = JSON.parse(
          message.toString(),
        ) as SubscriptionRequest;

        if (parsedMessage.method === "SUBSCRIBE") {
          parsedMessage.params?.forEach((stream) => {
            ws.data.subscribedStreams.add(stream);
          });

          ws.send(
            JSON.stringify({
              type: "subscription_ack",
              method: "SUBSCRIBE",
              params: parsedMessage.params ?? [],
            }),
          );
          return;
        }

        if (parsedMessage.method === "UNSUBSCRIBE") {
          parsedMessage.params?.forEach((stream) => {
            ws.data.subscribedStreams.delete(stream);
          });

          ws.send(
            JSON.stringify({
              type: "subscription_ack",
              method: "UNSUBSCRIBE",
              params: parsedMessage.params ?? [],
            }),
          );
          return;
        }

        ws.send(
          JSON.stringify({ type: "error", error: "Unknown websocket method" }),
        );
      } catch (error) {
        ws.send(
          JSON.stringify({
            type: "error",
            error:
              error instanceof Error
                ? error.message
                : "Invalid websocket message",
          }),
        );
      }
    },
    close(ws) {
      connectedClients.delete(ws);
    },
  },
});

async function handleForwardPrice(req: Request) {
  let body: Partial<PriceUpdateRequest>;

  try {
    body = (await req.json()) as Partial<PriceUpdateRequest>;
  } catch {
    return jsonResponse(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    );
  }

  if (!isValidPriceUpdate(body)) {
    return jsonResponse(
      { error: "Request body must include marketId and a numeric price" },
      { status: 400 },
    );
  }

  const price = Number(body.price);
  const marketId = body.marketId!.trim();
  const nowInMicroseconds = Date.now() * 1000;

  const update = {
    stream: `bookTicker.${marketId}`,
    data: {
      e: "bookTicker",
      E: nowInMicroseconds,
      s: marketId,
      a: String(price),
      A: "0",
      b: String(price),
      B: "0",
      u: String(nowInMicroseconds),
      T: nowInMicroseconds,
    },
  };

  const serializedUpdate = JSON.stringify(update);
  let forwardedTo = 0;

  for (const client of connectedClients) {
    if (client.data.subscribedStreams.has(update.stream)) {
      client.send(serializedUpdate);
      forwardedTo += 1;
    }
  }

  return jsonResponse({
    ok: true,
    forwardedTo,
    update,
  });
}

console.log(
  `exchange-price-mocker listening on http://localhost:${server.port} and ws://localhost:${server.port}`,
);
