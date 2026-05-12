import type { AssetOrderBook } from "./types/orderbook.types";

interface DepthLevel {
  price: number;
  quantity: number;
  total: number; // Sum of quantity
}

export function getMarketDepth(assetBook: AssetOrderBook) {
  // Bring bids into one map
  const bidMap: Record<number, number> = {};
  assetBook.bids.forEach((order) => {
    const remaining = order.quantity - order.filled;
    bidMap[order.price] = (bidMap[order.price] || 0) + remaining;
  });

  // Bring asks into one map
  const askMap: Record<number, number> = {};
  assetBook.asks.forEach((order) => {
    const remaining = order.quantity - order.filled;
    askMap[order.price] = (askMap[order.price] || 0) + remaining;
  });

  // Sort and accumulate bids (high to low)
  let bidTotal = 0;
  const bids: DepthLevel[] = Object.keys(bidMap)
    .map(Number)
    .sort((a, b) => b - a)
    .map((price) => {
      bidTotal += bidMap[price]!;
      return { price, quantity: bidMap[price] ?? 0, total: bidTotal };
    });

  // 4. Sort and Accumulate Asks (Low to High)
  let askTotal = 0;
  const asks: DepthLevel[] = Object.keys(askMap)
    .map(Number)
    .sort((a, b) => a - b)
    .map((price) => {
      askTotal += askMap[price]!;
      return { price, quantity: askMap[price] ?? 0, total: askTotal };
    });

  return { bids, asks };
}
