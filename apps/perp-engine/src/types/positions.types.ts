import type { Market, TradeSide } from "./orderbook.types";

interface Position {
  userId: string;
  positionId: string;
  orderId: string;
  market: Market;
  tradeSide: TradeSide;
  margin: number;
  averagePrice: number;
  quantity: number;
  liquidationPrice: number;
  entryPrice: number;
  upnl: number;
}

export type { Position };
