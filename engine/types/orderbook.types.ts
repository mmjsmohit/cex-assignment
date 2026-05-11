type MarketId = string;

export type TradeSide = "BUY" | "SELL";
export type OrderType = "LIMIT" | "MARKET";

interface Market {
  id: string;
  name: string;
  baseAssetId: string;
  quoteAssetId: string;
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
}

interface AssetOrderBook {
  bids: Order[];
  asks: Order[];
  lastTradedPrice: number;
}

type OrderBook = Record<MarketId, AssetOrderBook>;

export type { OrderBook, Order, MarketId, AssetOrderBook, Market };
