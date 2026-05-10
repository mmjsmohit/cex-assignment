import { ORDERBOOK } from ".";
import type { Order, OrderBook } from "./types/orderbook.types";
import { lockBalances, executeSwap, insertBid, insertAsk } from "./utils";

function getOrCreateBook(marketId: string): OrderBook[string] {
  let book = ORDERBOOK[marketId];
  if (!book) {
    ORDERBOOK[marketId] = {
      bids: [],
      asks: [],
      lastTradedPrice: 0,
    };
    book = ORDERBOOK[marketId];
  }

  return book;
}

export function processLimitBuy(
  marketId: string,
  incomingOrder: Order,
  baseAsset: string,
  quoteAsset: string,
) {
  const book = getOrCreateBook(marketId);
  let remainingQty = incomingOrder.quantity - incomingOrder.filled;

  // 1. Lock the required Quote Asset (USD) for the BUYER
  const requiredQuote = remainingQty * incomingOrder.price;
  if (!lockBalances(incomingOrder.userId, quoteAsset, requiredQuote)) {
    throw new Error("Insufficient funds");
  }

  // 2. Try to match with existing Asks (Sellers)
  while (remainingQty > 0 && book!.asks.length > 0) {
    const bestAsk = book?.asks[0]; // Lowest price seller

    // If the seller wants more than the buyer is willing to pay, stop matching
    if (bestAsk!.price > incomingOrder.price) {
      break;
    }

    // Determine how much we can actually trade right now
    const askRemainingQty = bestAsk!.quantity - bestAsk!.filled;
    const matchQty = Math.min(remainingQty, askRemainingQty);
    const matchPrice = bestAsk!.price; // Trade happens at the Maker's (Ask) price

    // 3. Settle the Trade (The Swap)
    executeSwap({
      buyerId: incomingOrder.userId,
      sellerId: bestAsk!.userId,
      baseAsset,
      quoteAsset,
      qty: matchQty,
      price: matchPrice,
    });

    // 4. Update Order States
    incomingOrder.filled += matchQty;
    bestAsk!.filled += matchQty;
    remainingQty -= matchQty;
    book!.lastTradedPrice = matchPrice;

    // 5. Remove fully filled maker orders from the book
    if (bestAsk!.filled === bestAsk!.quantity) {
      book!.asks.shift();
    }
  }

  // 6. If the incoming buy order wasn't fully filled, add it to the Bids book
  if (remainingQty > 0) {
    insertBid(book!.bids, incomingOrder);
  }
}

export function processLimitSell(
  marketId: string,
  incomingOrder: Order,
  baseAsset: string,
  quoteAsset: string,
) {
  const book = getOrCreateBook(marketId);
  let remainingQty = incomingOrder.quantity - incomingOrder.filled;

  // 1. Lock the required Base Asset for the SELLER
  if (!lockBalances(incomingOrder.userId, baseAsset, remainingQty)) {
    throw new Error("Insufficient funds");
  }

  // 2. Try to match with existing Bids (Buyers)
  while (remainingQty > 0 && book.bids.length > 0) {
    const bestBid = book.bids[0]!; // Highest price buyer

    // If the buyer is not willing to pay the seller's limit price, stop matching
    if (bestBid.price < incomingOrder.price) {
      break;
    }

    const bidRemainingQty = bestBid.quantity - bestBid.filled;
    const matchQty = Math.min(remainingQty, bidRemainingQty);
    const matchPrice = bestBid.price; // Trade happens at the Maker's (Bid) price

    executeSwap({
      buyerId: bestBid.userId,
      sellerId: incomingOrder.userId,
      baseAsset,
      quoteAsset,
      qty: matchQty,
      price: matchPrice,
    });

    incomingOrder.filled += matchQty;
    bestBid.filled += matchQty;
    remainingQty -= matchQty;
    book.lastTradedPrice = matchPrice;

    if (bestBid.filled === bestBid.quantity) {
      book.bids.shift();
    }
  }

  // 3. If the incoming sell order wasn't fully filled, add it to the Asks book
  if (remainingQty > 0) {
    insertAsk(book.asks, incomingOrder);
  }
}
