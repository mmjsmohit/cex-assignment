// This engine is responsible for building and storing the orderbook and balances.

// The engine handles creating orders, sending depth (ordersbook as a whole), user balances by receiving them from the
// redis queue and returning the response into another queue.

import { RedisClient } from "bun";
import type { Balances } from "./types/balances.types";
import type {
  AssetOrderBook,
  Order,
  OrderBook,
  TradeSide,
} from "./types/orderbook.types";
import { processLimitBuy, processLimitSell } from "./matching";
import { getMarketDepth } from "./depth";

// Define and initiate the clients for pushing and reading from Redis
const publisherClient = new RedisClient(process.env.REDIS_URL);
const subscriberClient = new RedisClient(process.env.REDIS_URL);

// Called when successfully connected to Redis server
publisherClient.onconnect = () => {
  console.log("Connected to Publisher Redis server");
};
subscriberClient.onconnect = () => {
  console.log("Connected to Subscriber Redis server");
};

publisherClient.onclose = (error) => {
  console.error("Disconnected from Publisher Redis server:", error);
};
subscriberClient.onclose = (error) => {
  console.error("Disconnected from the Subscriber Redis Client");
};

// Global in memory Balances Array
// Balances array which will store the balances of the users for each asset along with the fiat balance and locked fiat
export let BALANCES: Balances = {};

// Global Orderbook Object which includes every asset
// Stores the orderbooks of all the assets with their bids, asks and last traded price
export let ORDERBOOK: OrderBook = {};

async function* incomingMessageStream(subscribingClient: RedisClient) {
  while (true) {
    const response = await subscribingClient.send("BRPOP", [
      "incoming-orders",
      "balance",
      "0",
    ]);
    if (!response) continue;
    const [queue, message] = response;
    yield JSON.parse(message);
  }
}

for await (const parsedResponse of incomingMessageStream(subscriberClient)) {
  let data = {};
  const identifier = parsedResponse.identifier;
  if (parsedResponse.requestType === "create_order") {
    try {
      const tradeSide = String(parsedResponse.trade_side).toUpperCase();
      if (tradeSide !== "BUY" && tradeSide !== "SELL") {
        throw new Error("trade_side must be BUY or SELL");
      }

      const incomingOrder: Order = {
        orderId: parsedResponse.orderId,
        userId: parsedResponse.userId,
        price: parsedResponse.price,
        quantity: parsedResponse.quantity,
        filled: 0,
        fills: [],
        tradeSide: tradeSide as TradeSide,
        createdAt: Date.now(),
        market: parsedResponse.market,
      };
      const market = parsedResponse.market;

      // Process the incoming order
      if (incomingOrder.tradeSide === "BUY") {
        processLimitBuy(
          parsedResponse.market_id,
          incomingOrder,
          market.baseAssetId,
          market.quoteAssetId,
        );
      } else {
        processLimitSell(
          parsedResponse.market_id,
          incomingOrder,
          market.baseAssetId,
          market.quoteAssetId,
        );
      }

      data = {
        requestType: "create_order",
        identifier: incomingOrder.orderId,
        order: incomingOrder,
        orderbook: ORDERBOOK[parsedResponse.market_id],
      };

      // Publish to the WS server
      if (ORDERBOOK[incomingOrder.market.id]) {
        const currentMarketDepth =
          ORDERBOOK[incomingOrder.market.id] ?? ({} as AssetOrderBook);
        getMarketDepth(currentMarketDepth);
        await publisherClient.send("LPUSH", [
          "order-updates",
          JSON.stringify({
            currentMarketDepth,
            marketId: market.id,
          }),
        ]);
      }
    } catch (error) {
      data = {
        requestType: "create_order",
        identifier: parsedResponse.orderId,
        error:
          error instanceof Error ? error.message : "Failed to create order",
      };
    }
  }

  if (parsedResponse.requestType === "get_depth") {
    const { marketId, identifier } = parsedResponse;

    try {
      if (ORDERBOOK[marketId]) {
        const depthData = getMarketDepth(ORDERBOOK[marketId]);
        data = {
          type: "get_depth",
          identifier,
          depth: depthData,
        };
      } else {
        data = {
          type: "get_depth",
          identifier,
          error: "Market not found",
        };
      }
    } catch (e) {
      data = {
        type: "get_depth",
        identifier,
        error: e instanceof Error ? e.message : "Failed to get depth",
      };
    }
  }

  if (parsedResponse.requestType === "get_order") {
    const { userId, orderId, identifier } = parsedResponse;
    try {
      const userOrder = Object.entries(ORDERBOOK).map(([_, orderbook]) => {
        const order = [...orderbook.bids, ...orderbook.asks].filter(
          (order) => order.userId === userId && order.orderId === orderId,
        );
        return {
          order,
        };
      });
      data = {
        type: "get_order",
        identifier,
        order: userOrder,
      };
    } catch (error) {
      data = {
        type: "get_orders",
        identifier,
        error: error instanceof Error ? error.message : "Something went wrong",
      };
    }
  }

  if (parsedResponse.requestType === "delete_order") {
    const { userId, orderId, identifier } = parsedResponse;
    try {
      // Obtain the order to be deleted
      const targetOrder: Order | undefined = Object.entries(ORDERBOOK).map(
        ([_, orderbook]) =>
          // Spread all the bids and asks in a single array and filter the required order
          [...orderbook.bids, ...orderbook.asks].find(
            (order) => order.userId === userId && order.orderId === orderId,
          ),
      )[0];

      if (targetOrder) {
        // Check the trade side of the order (BUY/SELL)
        if (targetOrder?.tradeSide == "BUY") {
          // Since we are cancelling a buy order, we should unlock the quote asset from the user's balance
          const orderIndex = ORDERBOOK[targetOrder.market.id]?.bids.findIndex(
            (order) => order.orderId === targetOrder.orderId,
          );
          if (orderIndex != undefined) {
            ORDERBOOK[targetOrder.market.id]?.bids.splice(orderIndex, 1);
          }

          // Unlock the locked quote asset of the user
          const quoteAssetBalance = BALANCES[userId]?.find(
            (asset) => asset.assetId === targetOrder.market.quoteAssetId,
          );
          if (quoteAssetBalance) {
            quoteAssetBalance.amount += quoteAssetBalance?.lockedAmount;
            quoteAssetBalance.lockedAmount = 0;
          }
        } else {
          // Since we are cancelling a buy order, we should unlock the quote asset from the user's balance
          const orderIndex = ORDERBOOK[targetOrder.market.id]?.bids.findIndex(
            (order) => order.orderId === targetOrder.orderId,
          );
          if (orderIndex != undefined) {
            ORDERBOOK[targetOrder.market.id]?.bids.splice(orderIndex, 1);
          }

          // Unlock the locked quote asset of the user
          const baseAssetBalance = BALANCES[userId]?.find(
            (asset) => asset.assetId === targetOrder.market.baseAssetId,
          );
          if (baseAssetBalance) {
            baseAssetBalance.amount += baseAssetBalance?.lockedAmount;
            baseAssetBalance.lockedAmount = 0;
          }
        }

        data = {
          type: "delete_orders",
          identifier,
          message: "Order deleted successfully and balance has been updated",
        };
      } else {
        throw Error(
          "Order not found or you do not have the permission to delete this order",
        );
      }
    } catch (error) {
      data = {
        type: "delete_orders",
        identifier,
        error: error instanceof Error ? error.message : "Something went wrong",
      };
    }
  }

  if (parsedResponse.requestType === "get_all_orders") {
    const userId = parsedResponse.userId;
    const identifier = parsedResponse.identifier;
    try {
      const userOrders = Object.entries(ORDERBOOK)
        .map(([marketId, orderbook]) => {
          const orders = [...orderbook.bids, ...orderbook.asks].filter(
            (order) => order.userId === userId,
          );
          return {
            marketId,
            orders,
          };
        })
        .filter((marketOrders) => {
          return marketOrders.orders.length > 0;
        });
      // Add userOrders to the response
      data = {
        type: "get_all_orders",
        identifier,
        orders: userOrders,
      };
    } catch (error) {
      data = {
        type: "get_all_orders",
        identifier,
        error: error instanceof Error ? error.message : "Something went wrong",
      };
    }
  }

  if (parsedResponse.requestType === "get_balance") {
    const { userId, identifier } = parsedResponse;
    const balance = BALANCES[userId];
    data = {
      type: "get_balance",
      userId,
      balance: balance,
      identifier,
    };
  }

  if (parsedResponse.requestType === "get_usd_balance") {
    const { userId } = parsedResponse;
    const balance = BALANCES[userId];
    if (!balance) BALANCES[userId] = [];
    data = {
      type: "get_usd_balance",
      userId,
      balance,
      identifier,
    };
  }

  if (parsedResponse.requestType === "add_balance") {
    let finalBalance: number;
    const { userId, assetAmount, assetId } = parsedResponse;
    if (!BALANCES[userId]) BALANCES[userId] = [];

    // Check if the user already has a USD balance, and update it if so
    // TODO: Migrate to using the ID of the USD Asset in DB
    const previousBalance = BALANCES[userId]?.find(
      (asset) => asset.assetId === assetId,
    );
    if (previousBalance) {
      finalBalance = previousBalance.amount + assetAmount;
      previousBalance.amount = finalBalance;
    } else {
      finalBalance = assetAmount;
      BALANCES[userId].push({
        assetId: assetId,
        amount: finalBalance,
        lockedAmount: 0,
      });
    }

    data = {
      type: "add_balance",
      userId,
      finalBalance,
      identifier,
    };
  }

  await publisherClient.send("LPUSH", [
    "response-queue-" + parsedResponse.queue_id,
    JSON.stringify(data),
  ]);
}
