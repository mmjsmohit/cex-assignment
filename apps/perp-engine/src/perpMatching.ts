import { redis } from "bun";
import { PERP_ORDERBOOK } from ".";
import type {
  PerpAssetOrderBook,
  PerpOrder,
  PerpOrderBook,
} from "./types/orderbook.types";
import {
  calculateInitialMargin,
  insertAsk,
  insertBid,
  lockCollateral,
  matchPerpSwap,
  releaseLockedCollateral,
} from "./utils";

export function processPerpLimitBuy(incomingOrder: PerpOrder) {
  const book = PERP_ORDERBOOK[incomingOrder.market.id] as
    | PerpAssetOrderBook
    | undefined;
  if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks)) {
    throw new Error("Perpetual market orderbook not found");
  }

  if (!incomingOrder.entryPrice || incomingOrder.entryPrice <= 0) {
    throw new Error("Limit order price must be greater than zero");
  }
  if (incomingOrder.quantity <= 0) {
    throw new Error("Order quantity must be greater than zero");
  }
  if (incomingOrder.leverage <= 0) {
    throw new Error("Leverage must be greater than zero");
  }

  let remainingQty = incomingOrder.quantity - incomingOrder.filled;

  // 1. Lock initial margin for the full remaining LONG order at the limit price.
  const requiredQuote = calculateInitialMargin(
    remainingQty,
    incomingOrder.entryPrice,
    incomingOrder.leverage,
  );
  if (
    !lockCollateral(
      incomingOrder.userId,
      incomingOrder.market.quoteAssetId,
      requiredQuote,
      incomingOrder.market.id,
    )
  ) {
    throw new Error("Insufficient funds");
  }
  // Start with an empty fills array
  incomingOrder.fills = [];

  // 2. Try to match with existing SHORTS (Sellers)
  while (remainingQty > 0 && book.asks.length > 0) {
    const bestAsk = book.asks[0]; // Lowest price SHORT

    // If the SHORTer wants more than the buyer is willing to pay, stop matching
    if (bestAsk!.entryPrice! > incomingOrder.entryPrice!) {
      break;
    }

    // Determine how much we can actually trade right now
    const askRemainingQty = bestAsk!.quantity - bestAsk!.filled;
    const matchQty = Math.min(remainingQty, askRemainingQty);
    const matchPrice = bestAsk!.entryPrice; // Trade happens at the Maker's (Ask) price

    // 3. Match the Long and Short (The Swap)
    matchPerpSwap({
      orderId: incomingOrder.orderId,
      longerId: incomingOrder.userId,
      shorterId: bestAsk!.userId,
      qty: matchQty,
      price: matchPrice!,
      orderType: incomingOrder.orderType,
      market: incomingOrder.market,
      longerLeverage: incomingOrder.leverage || 1,
      shorterLeverage: bestAsk!.leverage || 1,
    });

    const reservedLongMargin = calculateInitialMargin(
      matchQty,
      incomingOrder.entryPrice,
      incomingOrder.leverage,
    );
    const executedLongMargin = calculateInitialMargin(
      matchQty,
      matchPrice!,
      incomingOrder.leverage,
    );
    releaseLockedCollateral(
      incomingOrder.userId,
      incomingOrder.market.quoteAssetId,
      reservedLongMargin - executedLongMargin,
    );

    // 4. Update Order States
    incomingOrder.filled += matchQty;
    bestAsk!.filled += matchQty;
    remainingQty -= matchQty;
    book!.lastTradedPrice = matchPrice!;

    // Maintain an array of fills in the order
    const now = Date.now();
    incomingOrder.fills.push({
      orderId: bestAsk!.orderId,
      price: matchPrice!,
      quantity: matchQty,
      filledAt: now,
    });
    bestAsk!.fills.push({
      orderId: incomingOrder.orderId,
      price: matchPrice!,
      quantity: matchQty,
      filledAt: now,
    });

    // 5. Remove fully filled maker orders from the book and persist their final state
    if (bestAsk!.filled >= bestAsk!.quantity) {
      book.asks.shift();
      redis.lpush("snapshot-queue", JSON.stringify(bestAsk));
    }
  }

  // Push the order to the Snapshot Queue so that it is stored in DB
  redis.lpush("snapshot-queue", JSON.stringify(incomingOrder));

  // 6. If the incoming buy order wasn't fully filled, add it to the Bids book
  if (remainingQty > 0) {
    insertBid(book.bids, incomingOrder);
  }
}

export function processPerpLimitSell(incomingOrder: PerpOrder) {
  const book = PERP_ORDERBOOK[incomingOrder.market.id] as
    | PerpAssetOrderBook
    | undefined;
  if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks)) {
    throw new Error("Perpetual market orderbook not found");
  }

  if (!incomingOrder.entryPrice || incomingOrder.entryPrice <= 0) {
    throw new Error("Limit order price must be greater than zero");
  }
  if (incomingOrder.quantity <= 0) {
    throw new Error("Order quantity must be greater than zero");
  }
  if (incomingOrder.leverage <= 0) {
    throw new Error("Leverage must be greater than zero");
  }

  let remainingQty = incomingOrder.quantity - incomingOrder.filled;

  // 1. Lock initial margin for the full remaining SHORT order at the limit price.
  const requiredQuote = calculateInitialMargin(
    remainingQty,
    incomingOrder.entryPrice,
    incomingOrder.leverage,
  );
  if (
    !lockCollateral(
      incomingOrder.userId,
      incomingOrder.market.quoteAssetId,
      requiredQuote,
      incomingOrder.market.id,
    )
  ) {
    throw new Error("Insufficient funds");
  }
  // Start with an empty fills array
  incomingOrder.fills = [];

  // 2. Try to match with existing LONGS (Buyers)
  while (remainingQty > 0 && book.bids.length > 0) {
    const bestBid = book.bids[0]; // Highest price LONG

    // If the buyer is not willing to pay the seller's limit price, stop matching
    if (bestBid!.entryPrice! < incomingOrder.entryPrice!) {
      break;
    }

    // Determine how much we can actually trade right now
    const bidRemainingQty = bestBid!.quantity - bestBid!.filled;
    const matchQty = Math.min(remainingQty, bidRemainingQty);
    const matchPrice = bestBid!.entryPrice; // Trade happens at the Maker's (Bid) price

    // 3. Adjust locked collateral BEFORE the swap.
    // For a short seller, the match always happens at the maker's bid price, which is
    // >= the seller's limit price. The margin consumed by matchPerpSwap is based on
    // the execution price, so we must ensure the locked amount covers it upfront.
    const reservedShortMargin = calculateInitialMargin(
      matchQty,
      incomingOrder.entryPrice,
      incomingOrder.leverage,
    );
    const executedShortMargin = calculateInitialMargin(
      matchQty,
      matchPrice!,
      incomingOrder.leverage,
    );
    const marginDelta = executedShortMargin - reservedShortMargin;

    if (marginDelta > 0) {
      // Execution price is above limit price — lock the extra margin needed before the swap.
      // If the user can't cover it, stop matching and rest the order in the book.
      if (
        !lockCollateral(
          incomingOrder.userId,
          incomingOrder.market.quoteAssetId,
          marginDelta,
          incomingOrder.market.id,
        )
      ) {
        break;
      }
    } else if (marginDelta < 0) {
      // Execution price is below limit price (guard — shouldn't happen for limit sells).
      releaseLockedCollateral(
        incomingOrder.userId,
        incomingOrder.market.quoteAssetId,
        -marginDelta,
      );
    }

    // 4. Match the Long and Short (The Swap)
    matchPerpSwap({
      orderId: incomingOrder.orderId,
      longerId: bestBid!.userId,
      shorterId: incomingOrder.userId,
      qty: matchQty,
      price: matchPrice!,
      orderType: incomingOrder.orderType,
      market: incomingOrder.market,
      longerLeverage: bestBid!.leverage || 1,
      shorterLeverage: incomingOrder.leverage || 1,
    });

    // 5. Update Order States
    incomingOrder.filled += matchQty;
    bestBid!.filled += matchQty;
    remainingQty -= matchQty;
    book.lastTradedPrice = matchPrice!;

    // Maintain an array of fills in the order
    const now = Date.now();
    incomingOrder.fills.push({
      orderId: bestBid!.orderId,
      price: matchPrice!,
      quantity: matchQty,
      filledAt: now,
    });
    bestBid!.fills.push({
      orderId: incomingOrder.orderId,
      price: matchPrice!,
      quantity: matchQty,
      filledAt: now,
    });

    // 6. Remove fully filled maker orders from the book and persist their final state
    if (bestBid!.filled >= bestBid!.quantity) {
      book.bids.shift();
      redis.lpush("snapshot-queue", JSON.stringify(bestBid));
    }
  }

  // Push the order to the Snapshot Queue so that it is stored in DB
  redis.lpush("snapshot-queue", JSON.stringify(incomingOrder));

  // 6. If the incoming sell order wasn't fully filled, add it to the Asks book
  if (remainingQty > 0) {
    insertAsk(book.asks, incomingOrder);
  }
}

// export function processPerpLimitSell(
//   marketId: string,
//   incomingOrder: Order,
//   baseAsset: string,
//   quoteAsset: string,
// ) {
//   const book = getOrCreateBook(marketId);
//   let remainingQty = incomingOrder.quantity - incomingOrder.filled;

//   // 1. Lock the required Base Asset for the SELLER
//   if (!lockBalances(incomingOrder.userId, baseAsset, remainingQty)) {
//     throw new Error("Insufficient funds");
//   }

//   // Start with an empty fills array
//   incomingOrder.fills = [];

//   // 2. Try to match with existing Bids (Buyers)
//   while (remainingQty > 0 && book.bids.length > 0) {
//     const bestBid = book.bids[0]!; // Highest price buyer

//     // If the buyer is not willing to pay the seller's limit price, stop matching
//     if (bestBid.price! < incomingOrder.price!) {
//       break;
//     }

//     const bidRemainingQty = bestBid.quantity - bestBid.filled;
//     const matchQty = Math.min(remainingQty, bidRemainingQty);
//     const matchPrice = bestBid.price; // Trade happens at the Maker's (Bid) price

//     executeSwap({
//       buyerId: bestBid.userId,
//       sellerId: incomingOrder.userId,
//       baseAsset,
//       quoteAsset,
//       qty: matchQty,
//       price: matchPrice!,
//       orderType: incomingOrder.orderType,
//     });

//     incomingOrder.filled += matchQty;
//     bestBid.filled += matchQty;
//     remainingQty -= matchQty;
//     book.lastTradedPrice = matchPrice!;

//     const fill = {
//       orderId: bestBid!.orderId,
//       price: matchPrice!,
//       quantity: matchQty,
//       filledAt: incomingOrder.createdAt,
//     };

//     incomingOrder.fills.push(fill);

//     if (bestBid.filled === bestBid.quantity) {
//       book.bids.shift();
//     }
//   }

//   // Push the order to the Snapshot Queue so that it is stored in DB
//   redis.lpush("snapshot-queue", JSON.stringify(incomingOrder));

//   // 3. If the incoming sell order wasn't fully filled, add it to the Asks book
//   if (remainingQty > 0) {
//     insertAsk(book.asks, incomingOrder);
//   }
// }

// export function processMarketBuy(
//   marketId: string,
//   incomingOrder: Order,
//   baseAsset: string,
//   quoteAsset: string,
// ) {
//   const book = getOrCreateBook(marketId);
//   let remainingQty = incomingOrder.quantity - incomingOrder.filled;

//   // 0. For MARKET order, there is no need to start locking balance.
//   // Start by checking if the market has enough to sell

//   let totalSellQuantity = 0;
//   book!.asks.map((ask) => (totalSellQuantity += ask.quantity));
//   if (totalSellQuantity < incomingOrder.quantity) {
//     throw new Error(
//       "Market does not have enough sellers to fulfill your order.",
//     );
//   }
//   // 1. Start with an empty fills array if order is possible
//   incomingOrder.fills = [];

//   // 2. Match the order with the best possible existing ask (most favourable seller)
//   while (remainingQty > 0 && book!.asks.length > 0) {
//     const bestAsk = book?.asks[0];
//     const askRemainingQty = bestAsk!.quantity - bestAsk!.filled;
//     const matchQty = Math.min(remainingQty, askRemainingQty);
//     const matchPrice = bestAsk!.price;

//     // 3. Settle the trade (The Swap)
//     executeSwap({
//       buyerId: incomingOrder.userId,
//       sellerId: bestAsk!.userId,
//       baseAsset,
//       quoteAsset,
//       qty: matchQty,
//       price: matchQty,
//       orderType: incomingOrder.orderType,
//     });

//     // 4. Update Order Status
//     incomingOrder.filled += matchQty;
//     bestAsk!.filled += matchQty;
//     remainingQty -= matchQty;
//     book!.lastTradedPrice = matchPrice!;

//     // Maintain an array of fills in the order
//     const fill = {
//       orderId: bestAsk!.orderId,
//       price: matchPrice!,
//       quantity: matchQty,
//       filledAt: incomingOrder.createdAt,
//     };
//     incomingOrder.fills.push(fill);

//     // 5. Remove fully filled maker orders from the book
//     if (bestAsk!.filled === bestAsk!.quantity) {
//       book!.asks.shift();
//     }
//   }

//   // Push the order to the Snapshot Queue so that it is stored in DB
//   redis.lpush("snapshot-queue", JSON.stringify(incomingOrder));
// }

// export function processMarketSell(
//   marketId: string,
//   incomingOrder: Order,
//   baseAsset: string,
//   quoteAsset: string,
// ) {
//   const book = getOrCreateBook(marketId);
//   let remainingQty = incomingOrder.quantity - incomingOrder.filled;

//   // 0. For MARKET order, there is no need to start locking balance.
//   // Start by checking if the market has enough to buy

//   let totalBidQuantity = 0;
//   book!.bids.map((bid) => (totalBidQuantity += bid.quantity));
//   if (totalBidQuantity < incomingOrder.quantity) {
//     throw new Error(
//       "Market does not have enough buyers to fulfill your order.",
//     );
//   }
//   // 1. Start with an empty fills array if order is possible
//   incomingOrder.fills = [];

//   // 2. Match the order with the best possible existing bid (most favourable buyer)
//   while (remainingQty > 0 && book!.bids.length > 0) {
//     const bestBid = book?.bids[0];
//     const bidRemainingQty = bestBid!.quantity - bestBid!.filled;
//     const matchQty = Math.min(remainingQty, bidRemainingQty);
//     const matchPrice = bestBid!.price;

//     // 3. Settle the trade (The Swap)
//     executeSwap({
//       buyerId: incomingOrder.userId,
//       sellerId: bestBid!.userId,
//       baseAsset,
//       quoteAsset,
//       qty: matchQty,
//       price: matchQty,
//       orderType: incomingOrder.orderType,
//     });

//     // 4. Update Order Status
//     incomingOrder.filled += matchQty;
//     bestBid!.filled += matchQty;
//     remainingQty -= matchQty;
//     book!.lastTradedPrice = matchPrice!;

//     // Maintain an array of fills in the order
//     const fill = {
//       orderId: bestBid!.orderId,
//       price: matchPrice!,
//       quantity: matchQty,
//       filledAt: incomingOrder.createdAt,
//     };
//     incomingOrder.fills.push(fill);

//     // 5. Remove fully filled maker orders from the book
//     if (bestBid!.filled === bestBid!.quantity) {
//       book!.bids.shift();
//     }
//   }

//   // Push the order to the Snapshot Queue so that it is stored in DB
//   redis.lpush("snapshot-queue", JSON.stringify(incomingOrder));
// }
