import { BALANCES } from ".";
import type { Order } from "./types/orderbook.types";

function getOrCreateAssetBalance(userId: string, assetId: string) {
  if (!BALANCES[userId]) BALANCES[userId] = [];

  let assetBalance = BALANCES[userId].find((asset) => asset.assetId === assetId);
  if (!assetBalance) {
    assetBalance = {
      assetId,
      amount: 0,
      lockedAmount: 0,
    };
    BALANCES[userId].push(assetBalance);
  }

  return assetBalance;
}

// Utility function for locking balances before an order is placed
function lockBalances(userId: string, assetId: string, amountToLock: number) {
  const userBalance = BALANCES[userId];
  // Check if the user has enough balance to be locked

  const userAsset = userBalance?.find((asset) => {
    return asset.assetId === assetId;
  });
  if (!userAsset || userAsset.amount < amountToLock) {
    return false;
  } else {
    BALANCES[userId]?.forEach((asset) => {
      if (asset.assetId === assetId) {
        asset.amount -= amountToLock;
        asset.lockedAmount += amountToLock;
      }
    });
    return true;
  }
}

function executeSwap(trade: {
  buyerId: string;
  sellerId: string;
  baseAsset: string;
  quoteAsset: string;
  qty: number;
  price: number;
}) {
  const { buyerId, sellerId, baseAsset, quoteAsset, qty, price } = trade;
  const totalQuoteValue = qty * price;

  const buyerBase = getOrCreateAssetBalance(buyerId, baseAsset);
  const buyerQuote = getOrCreateAssetBalance(buyerId, quoteAsset);
  const sellerBase = getOrCreateAssetBalance(sellerId, baseAsset);
  const sellerQuote = getOrCreateAssetBalance(sellerId, quoteAsset);

  // Buyer gets the Base Asset
  buyerBase.amount += qty;
  // Buyer pays Quote Asset from their locked balance
  buyerQuote.lockedAmount -= totalQuoteValue;

  // Seller gets Quote Asset
  sellerQuote.amount += totalQuoteValue;
  // Seller gives Base Asset from their locked balance (it was locked when they placed the ASK)
  sellerBase.lockedAmount -= qty;

  // TODO: Send an via Redis so the Express backend can write the trade history to db.
}

function insertBid(bids: Order[], order: Order) {
  // Sort descending by price. If prices are equal, sort by time (oldest first)
  bids.push(order);
  bids.sort((a, b) => {
    if (b.price === a.price) return a.createdAt - b.createdAt;
    return b.price - a.price;
  });
}

function insertAsk(asks: Order[], order: Order) {
  // Sort ascending by price. If prices are equal, sort by time (oldest first)
  asks.push(order);
  asks.sort((a, b) => {
    if (a.price === b.price) return a.createdAt - b.createdAt;
    return a.price - b.price;
  });
}

export { lockBalances, executeSwap, insertBid, insertAsk };
