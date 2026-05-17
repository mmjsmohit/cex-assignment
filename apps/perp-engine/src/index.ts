// This engine is responsible for building and storing the orderbook, positions and collaterals.

// The engine handles creating orders, sending depth (ordersbook as a whole), user balances by receiving them from the
// redis queue and returning the response into another queue.

import { RedisClient } from "bun";

// import {
//   processLimitBuy,
//   processLimitSell,
//   processMarketBuy,
//   processMarketSell,
// } from "./matching";
// import { getMarketDepth } from "./depth";

import type { Collaterals } from "./types/collaterals.types";
import type {
  PerpOrderBook,
  PerpOrder,
  TradeSide,
  Market,
  PerpAssetOrderBook,
} from "./types/orderbook.types";
import type { bookTick } from "./types/tick.types";
import type { Position } from "./types/positions.types";
import {
  getMarketDepth,
  getOrCreatePositions,
  liquidatePositions,
  waitForBackend,
  waitForExchangePriceMocker,
} from "./utils";
import { processPerpLimitBuy, processPerpLimitSell } from "./perpMatching";

// Define and initiate the clients for pushing and reading from Redis
const publisherClient = new RedisClient(process.env.REDIS_URL);
const subscriberClient = new RedisClient(process.env.REDIS_URL);
const IS_MOCK_EXCHANGE =
  process.env.IS_MOCK === "true" || process.env.IS_MOCK === "1";
const MOCK_EXCHANGE_WS_URL =
  process.env.MOCK_EXCHANGE_WS_URL || "ws://localhost:6000";

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

// Global in memory Collaterals Array
// Collaterals array which will store the collaterals of the users for each asset along with the fiat balance and locked fiat
export let COLLATERALS: Collaterals = {};

// Global Orderbook Object for Perpetuals which includes every market with its bids, asks, last traded price and index price
export let PERP_ORDERBOOK: PerpOrderBook = {};

// Global in-memory Positions Object to store the open positions of the users for each market
export let PERP_POSITIONS: Record<string, Position[]> = {};

// Keep polling the backend health endpoint every 500ms to check if it is up and get markets when it is up
let availableMarkets;
const markets = await waitForBackend();

// Initialize the orderbooks for each market
markets.forEach((market) => {
  PERP_ORDERBOOK[market.id] = {
    symbol: market.name,
    bids: [],
    asks: [],
    lastTradedPrice: 0,
    indexPrice: 0,
  };
  getOrCreatePositions(market.id);
});

if (IS_MOCK_EXCHANGE) {
  await waitForExchangePriceMocker();
}

// Subscribe the incoming market updates from Backpack WS Server or the local mocker
const exchangeSocket = new WebSocket(
  IS_MOCK_EXCHANGE ? MOCK_EXCHANGE_WS_URL : "wss://ws.backpack.exchange",
);

exchangeSocket.addEventListener("open", () => {
  // Build and subscribe to the markets and send the frame to WS
  const streams: string[] = [];
  markets.forEach((market) => streams.push(`bookTicker.${market.name}`));

  exchangeSocket.send(
    JSON.stringify({
      method: "SUBSCRIBE",
      params: streams,
    }),
  );
});

exchangeSocket.addEventListener("message", (event) => {
  const bookTick = JSON.parse(event.data.toString()) as bookTick & {
    type?: string;
    marketId?: string;
    price?: number;
    data?: bookTick["data"] & { marketId?: string; price?: number };
  };

  if (bookTick.type === "connected" || bookTick.type === "subscription_ack") {
    return;
  }

  const price =
    typeof bookTick.price === "number"
      ? bookTick.price
      : typeof bookTick.data?.price === "number"
        ? bookTick.data.price
        : (parseFloat(bookTick.data.a) + parseFloat(bookTick.data.b)) / 2;

  const marketId =
    bookTick.marketId ??
    bookTick.data?.marketId ??
    Object.entries(PERP_ORDERBOOK).find(
      ([marketId, orderbook]) =>
        marketId === bookTick.data.s || orderbook.symbol === bookTick.data.s,
    )?.[0];

  if (!marketId || !PERP_ORDERBOOK[marketId]) {
    console.error("Received price update for unknown market", bookTick);
    return;
  }

  // Update the index price of the market in the orderbook
  PERP_ORDERBOOK[marketId].indexPrice = price;

  // Loop through the positions of this market and calculate the unrealized PnL for each position and check if any position needs to be liquidated
  const needLiquidation: Position[] = [];
  const marketPositions = PERP_POSITIONS[marketId];

  marketPositions?.forEach((position, idx) => {
    let pnl: number = 0;

    // Calculate PnL depending upon if the position is LONG or SHORT
    if (position.tradeSide === "LONG") {
      // Update the PnL for the position in the global PERP_POSITIONS object
      pnl = position.quantity * (price - position.entryPrice);
      marketPositions[idx]!.upnl = pnl;
    } else {
      pnl = position.quantity * (position.entryPrice - price);
      marketPositions[idx]!.upnl = pnl;
    }

    // Mark this position for liquidation
    if (price === position.liquidationPrice) {
      needLiquidation.push(marketPositions[idx]!);
    }
  });

  console.log("POSITIONS IN NEED OF LIQUIDATION", needLiquidation);
  // Look for liquidity in the needLiquidation[] and execute the trades
  liquidatePositions(needLiquidation, price);
  console.log("POSITIONS FOR THIS MARKET\n", PERP_POSITIONS[marketId]);
  console.log("ORDERBOOK FOR THIS MARKET\n", PERP_ORDERBOOK[marketId]);
});

async function* incomingMessageStream(subscribingClient: RedisClient) {
  while (true) {
    const response = await subscribingClient.send("BRPOP", [
      // listen for new messages in the "incoming-perp-orders" & "collaterals" queue
      "perp-incoming-orders",
      "collaterals",
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
      const tradeSide: TradeSide = parsedResponse.trade_side;
      if (tradeSide !== "LONG" && tradeSide !== "SHORT") {
        throw new Error("trade_side must be LONG or SHORT");
      }

      const incomingOrder: PerpOrder = {
        orderId: parsedResponse.orderId,
        userId: parsedResponse.userId,
        entryPrice: parsedResponse.entryPrice,
        quantity: parsedResponse.quantity,
        filled: 0,
        fills: [],
        orderType: parsedResponse.order_type,
        tradeSide: tradeSide as TradeSide,
        createdAt: Date.now(),
        margin: parsedResponse.margin,
        market: parsedResponse.market,
        leverage: Number(parsedResponse.leverage ?? 1),
      };

      const market: Market = parsedResponse.market;

      // Process the incoming order
      if (incomingOrder.tradeSide === "LONG") {
        if (incomingOrder.orderType === "LIMIT") {
          processPerpLimitBuy(incomingOrder);
        } else {
          // TODO
          // processPerpMarketBuy();
        }
      } else {
        if (incomingOrder.orderType === "LIMIT") {
          processPerpLimitSell(incomingOrder);
        } else {
          // TODO
          // processPerpMarketSell();
        }
      }

      data = {
        requestType: "create_order",
        identifier: incomingOrder.orderId,
        order: incomingOrder,
        orderbook: PERP_ORDERBOOK[market.id],
      };

      // Publish to the WS server
      if (PERP_ORDERBOOK[incomingOrder.market.id]) {
        const currentMarketDepth =
          PERP_ORDERBOOK[incomingOrder.market.id] ?? ({} as PerpAssetOrderBook);
        await publisherClient.send("LPUSH", [
          "perp-order-updates",
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

  if (parsedResponse.requestType === "delete_order") {
    const { userId, orderId, identifier } = parsedResponse;
    try {
      // Obtain the order to be deleted
      const targetOrder: PerpOrder | undefined = Object.entries(
        PERP_ORDERBOOK,
      ).map(([_, orderbook]) =>
        // Spread all the bids and asks in a single array and filter the required order
        [...orderbook.bids, ...orderbook.asks].find(
          (order) => order.userId === userId && order.orderId === orderId,
        ),
      )[0];

      if (targetOrder) {
        // Check the trade side of the order (LONG/SHORT)
        if (targetOrder.tradeSide === "LONG") {
          // Since we are cancelling a futures order, we should unlock the margin and send it to the user's collateral balance
          const orderIndex = PERP_ORDERBOOK[
            targetOrder.market.id
          ]?.bids.findIndex((order) => order.orderId === targetOrder.orderId);
          if (orderIndex != undefined) {
            PERP_ORDERBOOK[targetOrder.market.id]?.bids.splice(orderIndex, 1);
          }

          // Unlock the locked quote asset of the user
          const collateralBalance = COLLATERALS[userId]?.find(
            (collateral) => collateral.marketId === targetOrder.orderId,
          );
          if (collateralBalance) {
            collateralBalance.amount += collateralBalance?.lockedAmount;
            collateralBalance.lockedAmount = 0;
          }
        } else {
          // Since we are cancelling a futures order, we should unlock the margin and send it to the user's collateral balance
          const orderIndex = PERP_ORDERBOOK[
            targetOrder.market.id
          ]?.asks.findIndex((order) => order.orderId === targetOrder.orderId);
          if (orderIndex != undefined) {
            PERP_ORDERBOOK[targetOrder.market.id]?.asks.splice(orderIndex, 1);
          }

          // Unlock the locked quote asset of the user
          const collateralBalance = COLLATERALS[userId]?.find(
            (collateral) => collateral.marketId === targetOrder.orderId,
          );
          if (collateralBalance) {
            collateralBalance.amount += collateralBalance?.lockedAmount;
            collateralBalance.lockedAmount = 0;
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

  if (parsedResponse.requestType === "add_collateral") {
    let finalBalance: number;
    const { userId, marketId, amount } = parsedResponse;
    if (!COLLATERALS[userId]) COLLATERALS[userId] = [];

    // Check if the user already has a collateral, and update it if so
    // TODO: Migrate to using the ID of the USD Asset in DB
    const previousBalance = COLLATERALS[userId]?.find(
      (collateral) => collateral.marketId === marketId,
    );
    if (previousBalance) {
      finalBalance = previousBalance.amount + amount;
      previousBalance.amount = finalBalance;
    } else {
      finalBalance = amount;
      COLLATERALS[userId].push({
        marketId: marketId,
        amount: finalBalance,
        lockedAmount: 0,
      });
    }

    data = {
      type: "add_collateral",
      userId,
      marketId,
      finalBalance,
      collaterals: COLLATERALS[userId],
      identifier,
    };
  }

  if (parsedResponse.requestType === "get_available_equity") {
    // Map through all the markets and find out the collaterals for the user
    console.log("COLLATERALS is: ", COLLATERALS);
    const { userId } = parsedResponse;
    data = {
      type: "get_available_equity",
      userId,
      collaterals: COLLATERALS[userId] ?? [],
      identifier,
    };
  }

  if (parsedResponse.requestType === "get_depth") {
    const { marketId, identifier } = parsedResponse;

    try {
      if (PERP_ORDERBOOK[marketId]) {
        const depthData = getMarketDepth(PERP_ORDERBOOK[marketId]);
        data = {
          type: "get_depth",
          identifier,
          depth: depthData,
          lastTradedPrice: PERP_ORDERBOOK[marketId].lastTradedPrice,
          indexPrice: PERP_ORDERBOOK[marketId].indexPrice,
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
      const userOrder = Object.values(PERP_ORDERBOOK)
        .flatMap((book) => [...book.asks, ...book.bids])
        .find((order) => order.userId === userId && order.orderId === orderId);

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

  // if (parsedResponse.requestType === "delete_order") {
  //   const { userId, orderId, identifier } = parsedResponse;
  //   try {
  //     // Obtain the order to be deleted
  //     const targetOrder: Order | undefined = Object.entries(ORDERBOOK).map(
  //       ([_, orderbook]) =>
  //         // Spread all the bids and asks in a single array and filter the required order
  //         [...orderbook.bids, ...orderbook.asks].find(
  //           (order) => order.userId === userId && order.orderId === orderId,
  //         ),
  //     )[0];

  //     if (targetOrder) {
  //       // Check the trade side of the order (BUY/SELL)
  //       if (targetOrder?.tradeSide == "BUY") {
  //         // Since we are cancelling a buy order, we should unlock the quote asset from the user's balance
  //         const orderIndex = ORDERBOOK[targetOrder.market.id]?.bids.findIndex(
  //           (order) => order.orderId === targetOrder.orderId,
  //         );
  //         if (orderIndex != undefined) {
  //           ORDERBOOK[targetOrder.market.id]?.bids.splice(orderIndex, 1);
  //         }

  //         // Unlock the locked quote asset of the user
  //         const quoteAssetBalance = BALANCES[userId]?.find(
  //           (asset) => asset.assetId === targetOrder.market.quoteAssetId,
  //         );
  //         if (quoteAssetBalance) {
  //           quoteAssetBalance.amount += quoteAssetBalance?.lockedAmount;
  //           quoteAssetBalance.lockedAmount = 0;
  //         }
  //       } else {
  //         // Since we are cancelling a buy order, we should unlock the quote asset from the user's balance
  //         const orderIndex = ORDERBOOK[targetOrder.market.id]?.bids.findIndex(
  //           (order) => order.orderId === targetOrder.orderId,
  //         );
  //         if (orderIndex != undefined) {
  //           ORDERBOOK[targetOrder.market.id]?.bids.splice(orderIndex, 1);
  //         }

  //         // Unlock the locked quote asset of the user
  //         const baseAssetBalance = BALANCES[userId]?.find(
  //           (asset) => asset.assetId === targetOrder.market.baseAssetId,
  //         );
  //         if (baseAssetBalance) {
  //           baseAssetBalance.amount += baseAssetBalance?.lockedAmount;
  //           baseAssetBalance.lockedAmount = 0;
  //         }
  //       }

  //       data = {
  //         type: "delete_orders",
  //         identifier,
  //         message: "Order deleted successfully and balance has been updated",
  //       };
  //     } else {
  //       throw Error(
  //         "Order not found or you do not have the permission to delete this order",
  //       );
  //     }
  //   } catch (error) {
  //     data = {
  //       type: "delete_orders",
  //       identifier,
  //       error: error instanceof Error ? error.message : "Something went wrong",
  //     };
  //   }
  // }

  if (parsedResponse.requestType === "get_all_orders") {
    const userId = parsedResponse.userId;
    const identifier = parsedResponse.identifier;
    try {
      const userOrders = Object.values(PERP_ORDERBOOK)
        .flatMap((book) => [...book.asks, ...book.bids])
        .filter((order) => order.userId === userId);

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

  // if (parsedResponse.requestType === "get_balance") {
  //   const { userId, identifier } = parsedResponse;
  //   const balance = BALANCES[userId];
  //   data = {
  //     type: "get_balance",
  //     userId,
  //     balance: balance,
  //     identifier,
  //   };
  // }

  // if (parsedResponse.requestType === "get_usd_balance") {
  //   const { userId } = parsedResponse;
  //   const balance = BALANCES[userId];
  //   if (!balance) BALANCES[userId] = [];
  //   data = {
  //     type: "get_usd_balance",
  //     userId,
  //     balance,
  //     identifier,
  //   };
  // }

  // if (parsedResponse.requestType === "add_balance") {
  //   let finalBalance: number;
  //   const { userId, assetAmount, assetId } = parsedResponse;
  //   if (!BALANCES[userId]) BALANCES[userId] = [];

  //   // Check if the user already has a USD balance, and update it if so
  //   // TODO: Migrate to using the ID of the USD Asset in DB
  //   const previousBalance = BALANCES[userId]?.find(
  //     (asset) => asset.assetId === assetId,
  //   );
  //   if (previousBalance) {
  //     finalBalance = previousBalance.amount + assetAmount;
  //     previousBalance.amount = finalBalance;
  //   } else {
  //     finalBalance = assetAmount;
  //     BALANCES[userId].push({
  //       assetId: assetId,
  //       amount: finalBalance,
  //       lockedAmount: 0,
  //     });
  //   }

  //   data = {
  //     type: "add_balance",
  //     userId,
  //     finalBalance,
  //     identifier,
  //   };
  // }
  await publisherClient.send("LPUSH", [
    "response-queue-" + parsedResponse.queue_id,
    JSON.stringify(data),
  ]);
}
