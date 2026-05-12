type MarketId = string;

export type TradeSide = "BUY" | "SELL";
export type OrderType = "LIMIT" | "MARKET";
export type OrderCompletion = "COMPLETED" | "PARTIAL" | "CANCELLED";

interface Market {
  id: string;
  name: string;
  baseAssetId: string;
  quoteAssetId: string;
}

interface Fill {
  orderId: string;
  price: number;
  quantity: number;
  filledAt: number;
}

interface Order {
  orderId: string;
  userId: string;
  price: number;
  quantity: number;
  filled: number;
  tradeSide: TradeSide;
  createdAt: number;
  market: Market;
  fills: Fill[];
}

interface AssetOrderBook {
  bids: Order[];
  asks: Order[];
  lastTradedPrice: number;
}

type OrderBook = Record<MarketId, AssetOrderBook>;

export type { OrderBook, Order, MarketId, AssetOrderBook, Market };
