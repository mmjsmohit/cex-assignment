import { COLLATERALS, PERP_POSITIONS } from ".";
import { processPerpLimitBuy, processPerpLimitSell } from "./perpMatching";

import type {
  Market,
  OrderType,
  PerpOrder,
  TradeSide,
} from "./types/orderbook.types";

import type { Position } from "./types/positions.types";
import { randomUUID } from "crypto";

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3000";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForBackend(): Promise<
  {
    id: string;
    name: string;
    baseAssetId: string;
    quoteAssetId: string;
  }[]
> {
  const maxAttempts = 50;
  const delay = 500;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${BACKEND_URL}/health`);

      if (response.ok) {
        console.log("Backend is up, fetching markets now");
        const marketsResponse = await fetch(`${BACKEND_URL}/markets`);
        return (await marketsResponse.json()) as {
          id: string;
          name: string;
          baseAssetId: string;
          quoteAssetId: string;
        }[];
      }

      console.log(
        `Waiting for backend with ${response.status}. Retrying ${i}/${maxAttempts}...`,
      );
    } catch (e) {
      console.log(
        `Error connecting to backend: ${e}. Retrying ${i}/${maxAttempts}...`,
      );
    }
    await sleep(delay);
  }

  throw new Error("Backend did not become available in time, exiting");
}

// Utility function for locking balances before an order is placed
export function lockCollateral(
  userId: string,
  assetId: string,
  amountToLock: number,
  marketId: string,
) {
  const userCollateral = getOrCreateAssetCollateral(userId, marketId);

  // Check if the user has enough balance to be locked.
  if (userCollateral.amount < amountToLock) {
    return false;
  }

  userCollateral.amount -= amountToLock;
  userCollateral.lockedAmount += amountToLock;
  return true;
}

export function consumeLockedCollateral(
  userId: string,
  marketId: string,
  amountToConsume: number,
) {
  const userCollateral = getOrCreateAssetCollateral(userId, marketId);
  if (userCollateral.lockedAmount < amountToConsume) {
    throw new Error("Insufficient locked collateral");
  }

  userCollateral.lockedAmount -= amountToConsume;
}

export function releaseLockedCollateral(
  userId: string,
  marketId: string,
  amountToRelease: number,
) {
  if (amountToRelease <= 0) return;

  const userCollateral = getOrCreateAssetCollateral(userId, marketId);
  const releasableAmount = Math.min(
    amountToRelease,
    userCollateral.lockedAmount,
  );
  userCollateral.lockedAmount -= releasableAmount;
  userCollateral.amount += releasableAmount;
}

export function matchPerpSwap(trade: {
  orderId: string;
  longerId: string;
  shorterId: string;
  qty: number;
  price: number;
  orderType: OrderType;
  market: Market;
  longerLeverage: number;
  shorterLeverage: number;
}) {
  const {
    orderId,
    longerId,
    shorterId,
    qty,
    price,
    market,
    longerLeverage,
    shorterLeverage,
  } = trade;

  const longerMargin = calculateInitialMargin(qty, price, longerLeverage);
  const shorterMargin = calculateInitialMargin(qty, price, shorterLeverage);

  consumeLockedCollateral(longerId, market.id, longerMargin);
  consumeLockedCollateral(shorterId, market.id, shorterMargin);

  // Entry price = matched price at the time of trade execution.
  const entryPrice = price;

  // TODO: Add maintenance margin requirement and fees to make liquidation math more realistic.
  const longerLiquidationPrice = entryPrice * (1 - 1 / longerLeverage);
  const shorterLiquidationPrice = entryPrice * (1 + 1 / shorterLeverage);

  upsertPosition({
    orderId,
    userId: longerId,
    market,
    tradeSide: "LONG",
    qty,
    margin: longerMargin,
    price,
    liquidationPrice: longerLiquidationPrice,
  });

  upsertPosition({
    orderId,
    userId: shorterId,
    market,
    tradeSide: "SHORT",
    qty,
    margin: shorterMargin,
    price,
    liquidationPrice: shorterLiquidationPrice,
  });

  // TODO: Send an event via Redis so the Express backend can write trade history to DB.
}

export function getOrCreateAssetCollateral(userId: string, marketId: string) {
  if (!COLLATERALS[userId]) COLLATERALS[userId] = [];

  let userCollateral = COLLATERALS[userId].find((collateral) => {
    return collateral.marketId === marketId;
  });

  if (!userCollateral) {
    userCollateral = {
      marketId: marketId,
      amount: 0,
      lockedAmount: 0,
    };
    COLLATERALS[userId].push(userCollateral);
  }

  return userCollateral;
}

export function getOrCreatePositions(marketId: string) {
  const marketPositions = PERP_POSITIONS[marketId];
  if (!marketPositions) {
    PERP_POSITIONS[marketId] = [];
    return PERP_POSITIONS[marketId];
  }
  return marketPositions;
}

export function calculateInitialMargin(
  quantity: number,
  price: number,
  leverage: number,
) {
  if (leverage <= 0) {
    throw new Error("Leverage must be greater than zero");
  }

  return (quantity * price) / leverage;
}

function upsertPosition({
  userId,
  market,
  tradeSide,
  qty,
  margin,
  price,
  liquidationPrice,
  orderId,
}: {
  userId: string;
  orderId: string;
  market: Market;
  tradeSide: TradeSide;
  qty: number;
  margin: number;
  price: number;
  liquidationPrice: number;
}) {
  const marketPositions = getOrCreatePositions(market.id);
  const existingPosition = marketPositions.find(
    (position) => position.userId === userId,
  );

  if (existingPosition && existingPosition.tradeSide !== tradeSide) {
    throw new Error(
      "Reducing or flipping an existing position is not implemented yet.",
    );
  }

  if (!existingPosition) {
    marketPositions.push({
      userId,
      positionId: randomUUID(),
      market,
      tradeSide,
      quantity: qty,
      margin,
      averagePrice: price,
      liquidationPrice,
      entryPrice: price,
      orderId: orderId,
      upnl: 0, // Every position starts with 0 P/L until the next price update comes in.
    });
    return;
  }

  const nextQuantity = existingPosition.quantity + qty;
  existingPosition.averagePrice =
    (existingPosition.averagePrice * existingPosition.quantity + price * qty) /
    nextQuantity;
  existingPosition.quantity = nextQuantity;
  existingPosition.margin += margin;
  existingPosition.liquidationPrice = liquidationPrice;
}

export function insertBid(bids: PerpOrder[], order: PerpOrder) {
  // Sort descending by price. If prices are equal, sort by time (oldest first)
  bids.push(order);
  bids.sort((a, b) => {
    if (b.entryPrice === a.entryPrice) return a.createdAt - b.createdAt;
    return b.entryPrice! - a.entryPrice!;
  });
}

export function insertAsk(asks: PerpOrder[], order: PerpOrder) {
  // Sort ascending by price. If prices are equal, sort by time (oldest first)
  asks.push(order);
  asks.sort((a, b) => {
    if (a.entryPrice === b.entryPrice) return a.createdAt - b.createdAt;
    return a.entryPrice! - b.entryPrice!;
  });
}

export function liquidatePositions(
  positions: Position[],
  currentPrice: number,
) {
  positions.forEach((position) => {
    // Build an opposing incomingOrder based on the position details (LONG -> LIMIT SHORT, SHORT -> LIMIT LONG)
    const opposingOrder: PerpOrder = {
      userId: position.userId,
      orderId: position.orderId,
      market: position.market,
      entryPrice: currentPrice,
      quantity: position.quantity,
      margin: position.margin,
      filled: 0,
      orderType: "LIMIT",
      tradeSide: position.tradeSide === "LONG" ? "SHORT" : "LONG",
      createdAt: Date.now(),
      fills: [],
      leverage: 1,
    };
    // Process this opposing order as normal
    if (opposingOrder.tradeSide === "LONG") {
      processPerpLimitBuy(opposingOrder);
    } else {
      processPerpLimitSell(opposingOrder);
    }
  });
}
