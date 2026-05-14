"use client";

import {
  type Dispatch,
  type FormEvent,
  type SetStateAction,
  useEffect,
  useMemo,
  useState,
} from "react";
import styles from "./page.module.css";

type HttpMethod = "GET" | "POST" | "DELETE";

type ApiResult = {
  method: HttpMethod;
  path: string;
  requestBody?: unknown;
  status?: number;
  ok?: boolean;
  response?: unknown;
  error?: string;
};

type DepthLevel = {
  price: number;
  quantity: number;
  total: number;
};

type MarketDepth = {
  bids: DepthLevel[];
  asks: DepthLevel[];
};

type WsStatus = "idle" | "connecting" | "connected" | "closed" | "error";

type AssetOption = {
  id: string;
  name: string;
  symbol: string;
};

type MarketOption = {
  id: string;
  name: string;
  baseAssetId: string;
  quoteAssetId: string;
};

type OrderOption = {
  orderId: string;
  marketId?: string;
  price?: number;
  quantity?: number;
  tradeSide?: string;
};

const tokenStorageKey = "cex-debug-jwt";
const defaultWsUrl = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4000";

const initialFields = {
  auth: {
    username: "debug@example.com",
    name: "Debug User",
    password: "password123",
  },
  asset: {
    name: "US Dollar",
    symbol: "USD",
    logo: "https://example.com/usd.png",
  },
  market: {
    baseAssetId: "",
    quoteAssetId: "",
    depthMarketId: "",
  },
  balance: {
    assetId: "",
    assetAmount: "1000",
  },
  order: {
    market_id: "",
    price: "100",
    quantity: "1",
    trade_side: "BUY",
    order_type: "LIMIT",
  },
  orderLookup: {
    orderId: "",
  },
};

export default function Home() {
  const [jwt, setJwt] = useState("");
  const [auth, setAuth] = useState(initialFields.auth);
  const [asset, setAsset] = useState(initialFields.asset);
  const [market, setMarket] = useState(initialFields.market);
  const [balance, setBalance] = useState(initialFields.balance);
  const [order, setOrder] = useState(initialFields.order);
  const [orderLookup, setOrderLookup] = useState(initialFields.orderLookup);
  const [assets, setAssets] = useState<AssetOption[]>([]);
  const [markets, setMarkets] = useState<MarketOption[]>([]);
  const [orders, setOrders] = useState<OrderOption[]>([]);
  const [depth, setDepth] = useState<MarketDepth>({ bids: [], asks: [] });
  const [wsStatus, setWsStatus] = useState<WsStatus>("idle");
  const [result, setResult] = useState<ApiResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const isSignedIn = jwt.trim().length > 0;
  const resultJson = useMemo(() => {
    if (!result) return "No request sent yet.";
    return JSON.stringify(result.response ?? result.error, null, 2);
  }, [result]);

  useEffect(() => {
    const storedToken = window.localStorage.getItem(tokenStorageKey);
    if (storedToken) {
      setJwt(storedToken);
    }
  }, []);

  useEffect(() => {
    if (jwt) {
      window.localStorage.setItem(tokenStorageKey, jwt);
    } else {
      window.localStorage.removeItem(tokenStorageKey);
    }
  }, [jwt]);

  useEffect(() => {
    const selectedMarketId = market.depthMarketId;

    if (!selectedMarketId) {
      setWsStatus("idle");
      setDepth({ bids: [], asks: [] });
      return;
    }

    async function fetchInitialDepth(marketId: string) {
      try {
        const response = await fetch(`/api/debug/depth/${marketId}`);
        const parsedResponse = parseResponse(await response.text());
        const parsedDepth = extractDepth(parsedResponse);

        if (parsedDepth) {
          setDepth(parsedDepth);
        }
      } catch {
        setDepth({ bids: [], asks: [] });
      }
    }

    void fetchInitialDepth(selectedMarketId);

    const socketUrl = new URL(process.env.NEXT_PUBLIC_WS_URL ?? defaultWsUrl);
    socketUrl.searchParams.set("marketId", selectedMarketId);

    const socket = new WebSocket(socketUrl.toString());
    setWsStatus("connecting");

    socket.addEventListener("open", () => {
      setWsStatus("connected");
    });

    socket.addEventListener("message", (event) => {
      const parsedDepth = extractDepthFromWsMessage(
        event.data,
        selectedMarketId,
      );

      if (parsedDepth) {
        setDepth(parsedDepth);
      }
    });

    socket.addEventListener("error", () => {
      setWsStatus("error");
    });

    socket.addEventListener("close", () => {
      setWsStatus("closed");
    });

    return () => {
      socket.close();
    };
  }, [market.depthMarketId]);

  async function callApi(
    method: HttpMethod,
    path: string,
    body?: Record<string, unknown>,
  ) {
    setIsLoading(true);

    const requestBody = body ? pruneEmptyFields(body) : undefined;
    const requestSummary: ApiResult = {
      method,
      path,
      requestBody,
    };

    setResult(requestSummary);

    try {
      const response = await fetch(`/api/debug${path}`, {
        method,
        headers: {
          ...(requestBody ? { "Content-Type": "application/json" } : {}),
          ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
        },
        body: requestBody ? JSON.stringify(requestBody) : undefined,
      });

      const text = await response.text();
      const parsedResponse = parseResponse(text);

      const nextResult = {
        ...requestSummary,
        status: response.status,
        ok: response.ok,
        response: parsedResponse,
      };

      setResult(nextResult);

      if (path === "/signin" && response.ok && isObject(parsedResponse)) {
        const nextToken = parsedResponse.jwt;
        if (typeof nextToken === "string") {
          setJwt(nextToken);
        }
      }

      syncDropdownOptions(path, parsedResponse);

      return nextResult;
    } catch (error) {
      const nextResult = {
        ...requestSummary,
        error: error instanceof Error ? error.message : String(error),
      };

      setResult(nextResult);
      return nextResult;
    } finally {
      setIsLoading(false);
    }
  }

  async function fetchDepth() {
    if (!market.depthMarketId) return;

    await fetchDepthForMarket(market.depthMarketId);
  }

  async function fetchDepthForMarket(marketId: string) {
    const depthResult = await callApi("GET", `/depth/${marketId}`);
    const parsedDepth = extractDepth(depthResult.response);

    if (parsedDepth) {
      setDepth(parsedDepth);
    }
  }

  async function refreshAssets() {
    await callApi("GET", "/assets");
  }

  async function refreshMarkets() {
    await callApi("GET", "/markets");
  }

  async function refreshOrders() {
    await callApi("GET", "/orders");
  }

  function syncDropdownOptions(path: string, response: unknown) {
    if (path === "/assets") {
      const nextAssets = extractAssets(response);
      if (nextAssets.length > 0) {
        setAssets((current) => mergeById(current, nextAssets));
      }
    }

    if (path === "/markets") {
      const nextMarkets = extractMarkets(response);
      if (nextMarkets.length > 0) {
        setMarkets((current) => mergeById(current, nextMarkets));
      }
    }

    if (path === "/orders") {
      setOrders(extractOrders(response));
    }

    if (path === "/order") {
      const createdOrder = extractCreatedOrder(response);
      if (createdOrder) {
        setOrders((current) => mergeByOrderId(current, [createdOrder]));
      }
    }
  }

  function updateFields<T extends object>(
    setter: Dispatch<SetStateAction<T>>,
    current: T,
    key: keyof T,
    value: string,
  ) {
    setter({
      ...current,
      [key]: value,
    } as T);
  }

  function handleSubmit(callback: () => void) {
    return (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      callback();
    };
  }

  return (
    <main className={styles.page}>
      <section className={styles.header}>
        <div>
          <p className={styles.eyebrow}>CEX API</p>
          <h1>Debug Console</h1>
        </div>
        <div className={styles.status}>
          <span
            className={isSignedIn ? styles.statusDotOn : styles.statusDot}
          />
          {isSignedIn ? "JWT loaded" : "No JWT"}
        </div>
      </section>

      <section className={styles.layout}>
        <div className={styles.controls}>
          <Panel title="Auth">
            <form
              className={styles.form}
              onSubmit={handleSubmit(() =>
                callApi("POST", "/signup", {
                  username: auth.username,
                  name: auth.name,
                  password: auth.password,
                }),
              )}
            >
              <Field
                label="Username"
                value={auth.username}
                onChange={(value) =>
                  updateFields(setAuth, auth, "username", value)
                }
              />
              <Field
                label="Name"
                value={auth.name}
                onChange={(value) => updateFields(setAuth, auth, "name", value)}
              />
              <Field
                label="Password"
                type="password"
                value={auth.password}
                onChange={(value) =>
                  updateFields(setAuth, auth, "password", value)
                }
              />
              <div className={styles.buttonRow}>
                <button type="submit" disabled={isLoading}>
                  Sign up
                </button>
                <button
                  type="button"
                  disabled={isLoading}
                  onClick={() =>
                    callApi("POST", "/signin", {
                      username: auth.username,
                      password: auth.password,
                    })
                  }
                >
                  Sign in
                </button>
                <button type="button" onClick={() => setJwt("")}>
                  Reset JWT
                </button>
              </div>
              <label className={styles.field}>
                <span>JWT</span>
                <textarea
                  value={jwt}
                  onChange={(event) => setJwt(event.target.value)}
                  spellCheck={false}
                  rows={4}
                  placeholder="Sign in or paste a token"
                />
              </label>
            </form>
          </Panel>

          <Panel title="Assets">
            <form
              className={styles.form}
              onSubmit={handleSubmit(() =>
                callApi("POST", "/assets", {
                  name: asset.name,
                  symbol: asset.symbol,
                  logo: asset.logo,
                }),
              )}
            >
              <Field
                label="Name"
                value={asset.name}
                onChange={(value) =>
                  updateFields(setAsset, asset, "name", value)
                }
              />
              <Field
                label="Symbol"
                value={asset.symbol}
                onChange={(value) =>
                  updateFields(setAsset, asset, "symbol", value.toUpperCase())
                }
              />
              <Field
                label="Logo"
                value={asset.logo}
                onChange={(value) =>
                  updateFields(setAsset, asset, "logo", value)
                }
              />
              <AuthHint isSignedIn={isSignedIn} />
              <div className={styles.buttonRow}>
                <button type="submit" disabled={!isSignedIn || isLoading}>
                  Create asset
                </button>
                <button
                  type="button"
                  disabled={!isSignedIn || isLoading}
                  onClick={refreshAssets}
                >
                  List assets
                </button>
              </div>
            </form>
          </Panel>

          <Panel title="Markets">
            <form
              className={styles.form}
              onSubmit={handleSubmit(() =>
                callApi("POST", "/markets", {
                  baseAssetId: market.baseAssetId,
                  quoteAssetId: market.quoteAssetId,
                }),
              )}
            >
              <SelectField
                label="Base asset"
                value={market.baseAssetId}
                onChange={(value) =>
                  updateFields(setMarket, market, "baseAssetId", value)
                }
                options={assets.map((assetOption) => ({
                  value: assetOption.id,
                  label: formatAssetOption(assetOption),
                }))}
                placeholder="Load assets first"
              />
              <SelectField
                label="Quote asset"
                value={market.quoteAssetId}
                onChange={(value) =>
                  updateFields(setMarket, market, "quoteAssetId", value)
                }
                options={assets.map((assetOption) => ({
                  value: assetOption.id,
                  label: formatAssetOption(assetOption),
                }))}
                placeholder="Load assets first"
              />
              <SelectField
                label="Depth market"
                value={market.depthMarketId}
                onChange={(value) =>
                  updateFields(setMarket, market, "depthMarketId", value)
                }
                options={markets.map((marketOption) => ({
                  value: marketOption.id,
                  label: formatMarketOption(marketOption),
                }))}
                placeholder="Load markets first"
              />
              <AuthHint isSignedIn={isSignedIn} />
              {assets.length === 0 ? (
                <p className={styles.hint}>
                  List assets to populate asset dropdowns.
                </p>
              ) : null}
              {markets.length === 0 ? (
                <p className={styles.hint}>
                  List markets to populate market dropdowns.
                </p>
              ) : null}
              <div className={styles.buttonRow}>
                <button type="submit" disabled={!isSignedIn || isLoading}>
                  Create market
                </button>
                <button
                  type="button"
                  disabled={isLoading}
                  onClick={refreshMarkets}
                >
                  List markets
                </button>
                <button
                  type="button"
                  disabled={!market.depthMarketId || isLoading}
                  onClick={fetchDepth}
                >
                  Get depth
                </button>
              </div>
            </form>
          </Panel>

          <Panel title="Balances">
            <form
              className={styles.form}
              onSubmit={handleSubmit(() =>
                callApi("POST", "/balance", {
                  assetId: balance.assetId,
                  assetAmount: Number(balance.assetAmount),
                }),
              )}
            >
              <SelectField
                label="Asset"
                value={balance.assetId}
                onChange={(value) =>
                  updateFields(setBalance, balance, "assetId", value)
                }
                options={assets.map((assetOption) => ({
                  value: assetOption.id,
                  label: formatAssetOption(assetOption),
                }))}
                placeholder="Load assets first"
              />
              <Field
                label="Amount"
                type="number"
                value={balance.assetAmount}
                onChange={(value) =>
                  updateFields(setBalance, balance, "assetAmount", value)
                }
              />
              <AuthHint isSignedIn={isSignedIn} />
              {assets.length === 0 ? (
                <p className={styles.hint}>
                  List assets to populate this dropdown.
                </p>
              ) : null}
              <div className={styles.buttonRow}>
                <button type="submit" disabled={!isSignedIn || isLoading}>
                  Add balance
                </button>
                <button
                  type="button"
                  disabled={!isSignedIn || isLoading}
                  onClick={() => callApi("GET", "/balance")}
                >
                  Get balance
                </button>
                <button
                  type="button"
                  disabled={!isSignedIn || isLoading}
                  onClick={() => callApi("GET", "/balance/usd")}
                >
                  Get USD
                </button>
              </div>
            </form>
          </Panel>

          <Panel title="Orders">
            <form
              className={styles.form}
              onSubmit={handleSubmit(() =>
                callApi("POST", "/order", {
                  market_id: order.market_id,
                  price: Number(order.price),
                  quantity: Number(order.quantity),
                  trade_side: order.trade_side,
                  order_type: order.order_type,
                }),
              )}
            >
              <SelectField
                label="Market"
                value={order.market_id}
                onChange={(value) =>
                  updateFields(setOrder, order, "market_id", value)
                }
                options={markets.map((marketOption) => ({
                  value: marketOption.id,
                  label: formatMarketOption(marketOption),
                }))}
                placeholder="Load markets first"
              />
              <div className={styles.inlineGrid}>
                <Field
                  label="Price"
                  type="number"
                  value={order.price}
                  onChange={(value) =>
                    updateFields(setOrder, order, "price", value)
                  }
                />
                <Field
                  label="Quantity"
                  type="number"
                  value={order.quantity}
                  onChange={(value) =>
                    updateFields(setOrder, order, "quantity", value)
                  }
                />
              </div>
              <div className={styles.inlineGrid}>
                <label className={styles.field}>
                  <span>Side</span>
                  <select
                    value={order.trade_side}
                    onChange={(event) =>
                      updateFields(
                        setOrder,
                        order,
                        "trade_side",
                        event.target.value,
                      )
                    }
                  >
                    <option value="BUY">BUY</option>
                    <option value="SELL">SELL</option>
                  </select>
                </label>
                <label className={styles.field}>
                  <span>Type</span>
                  <select
                    value={order.order_type}
                    onChange={(event) =>
                      updateFields(
                        setOrder,
                        order,
                        "order_type",
                        event.target.value,
                      )
                    }
                  >
                    <option value="LIMIT">LIMIT</option>
                    <option value="MARKET">MARKET</option>
                  </select>
                </label>
              </div>
              <SelectField
                label="Order"
                value={orderLookup.orderId}
                onChange={(value) =>
                  updateFields(setOrderLookup, orderLookup, "orderId", value)
                }
                options={orders.map((orderOption) => ({
                  value: orderOption.orderId,
                  label: formatOrderOption(orderOption),
                }))}
                placeholder="List orders first"
              />
              <AuthHint isSignedIn={isSignedIn} />
              {markets.length === 0 ? (
                <p className={styles.hint}>
                  List markets to populate market dropdowns.
                </p>
              ) : null}
              {orders.length === 0 ? (
                <p className={styles.hint}>
                  List orders to populate order dropdowns.
                </p>
              ) : null}
              <div className={styles.buttonRow}>
                <button type="submit" disabled={!isSignedIn || isLoading}>
                  Create order
                </button>
                <button
                  type="button"
                  disabled={!isSignedIn || isLoading}
                  onClick={refreshOrders}
                >
                  List orders
                </button>
                <button
                  type="button"
                  disabled={!isSignedIn || isLoading || !orderLookup.orderId}
                  onClick={() =>
                    callApi("GET", `/order/${orderLookup.orderId}`)
                  }
                >
                  Get order
                </button>
                <button
                  type="button"
                  disabled={!isSignedIn || isLoading || !orderLookup.orderId}
                  onClick={() =>
                    callApi("DELETE", `/order/${orderLookup.orderId}`)
                  }
                >
                  Delete order
                </button>
              </div>
            </form>
          </Panel>
        </div>

        <aside className={styles.sideColumn}>
          <section className={styles.depthPanel}>
            <div className={styles.responseHeader}>
              <div>
                <p className={styles.eyebrow}>Market depth</p>
                <h2>{market.depthMarketId || "Select a market"}</h2>
              </div>
              <div className={styles.depthActions}>
                <span className={styles.wsStatus} data-status={wsStatus}>
                  WS {wsStatus}
                </span>
                <button
                  type="button"
                  disabled={!market.depthMarketId || isLoading}
                  onClick={fetchDepth}
                  className={styles.refreshButton}
                >
                  Refresh
                </button>
              </div>
            </div>

            <DepthView depth={depth} />
          </section>

          <section className={styles.responsePanel}>
            <div className={styles.responseHeader}>
              <div>
                <p className={styles.eyebrow}>Latest response</p>
                <h2>{result ? `${result.method} ${result.path}` : "Idle"}</h2>
              </div>
              {result?.status ? (
                <span
                  className={result.ok ? styles.okBadge : styles.errorBadge}
                >
                  {result.status}
                </span>
              ) : null}
            </div>

            {result?.requestBody ? (
              <>
                <h3>Request body</h3>
                <pre>{JSON.stringify(result.requestBody, null, 2)}</pre>
              </>
            ) : null}

            <h3>Response</h3>
            <pre>{resultJson}</pre>
          </section>
        </aside>
      </section>
    </main>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className={styles.panel}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "password" | "number";
}) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        step={type === "number" ? "any" : undefined}
        spellCheck={false}
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder: string;
}) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={options.length === 0}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option value={option.value} key={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function AuthHint({ isSignedIn }: { isSignedIn: boolean }) {
  if (isSignedIn) return null;
  return (
    <p className={styles.hint}>Sign in or paste a JWT to use this call.</p>
  );
}

function DepthView({ depth }: { depth: MarketDepth }) {
  const asks = [...depth.asks].sort(
    (first, second) => second.price - first.price,
  );
  const bids = [...depth.bids].sort(
    (first, second) => second.price - first.price,
  );
  const bestAsk = depth.asks.reduce<number | null>(
    (best, level) =>
      best === null ? level.price : Math.min(best, level.price),
    null,
  );
  const bestBid = depth.bids.reduce<number | null>(
    (best, level) =>
      best === null ? level.price : Math.max(best, level.price),
    null,
  );
  const spread =
    bestAsk !== null && bestBid !== null
      ? Math.max(bestAsk - bestBid, 0)
      : null;
  const maxTotal = Math.max(
    ...depth.asks.map((level) => level.total),
    ...depth.bids.map((level) => level.total),
    1,
  );

  return (
    <div className={styles.depthBook}>
      <DepthTable levels={asks} maxTotal={maxTotal} side="ask" />
      <div className={styles.spreadRow}>
        <span>Spread</span>
        <strong>{spread === null ? "--" : formatNumber(spread)}</strong>
      </div>
      <DepthTable levels={bids} maxTotal={maxTotal} side="bid" />
    </div>
  );
}

function DepthTable({
  levels,
  maxTotal,
  side,
}: {
  levels: DepthLevel[];
  maxTotal: number;
  side: "ask" | "bid";
}) {
  return (
    <div className={styles.depthTable}>
      <div className={styles.depthHeader}>
        <span>Price</span>
        <span>Qty</span>
        <span>Total</span>
      </div>
      {levels.length === 0 ? (
        <div className={styles.emptyDepth}>No {side}s</div>
      ) : (
        levels.map((level) => {
          const barWidth = Math.min((level.total / maxTotal) * 100, 100);

          return (
            <div
              className={styles.depthRow}
              key={`${side}-${level.price}-${level.quantity}-${level.total}`}
            >
              <span
                className={
                  side === "bid" ? styles.depthBidPrice : styles.depthAskPrice
                }
              >
                {formatNumber(level.price)}
              </span>
              <span>{formatNumber(level.quantity)}</span>
              <span>{formatNumber(level.total)}</span>
              <span
                className={
                  side === "bid" ? styles.depthBidBar : styles.depthAskBar
                }
                style={{ width: `${barWidth}%` }}
              />
            </div>
          );
        })
      )}
    </div>
  );
}

function parseResponse(text: string) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function pruneEmptyFields(body: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== ""),
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractDepth(response: unknown): MarketDepth | null {
  if (!isObject(response) || !isObject(response.loopbackResponse)) {
    return null;
  }

  const rawDepth = response.loopbackResponse.depth;
  if (!isObject(rawDepth)) {
    return null;
  }

  const bids = parseDepthLevels(rawDepth.bids);
  const asks = parseDepthLevels(rawDepth.asks);

  return { bids, asks };
}

function extractDepthFromWsMessage(message: unknown, selectedMarketId: string) {
  const parsedMessage =
    typeof message === "string" ? parseResponse(message) : message;

  if (!isObject(parsedMessage)) {
    return null;
  }

  if (stringFrom(parsedMessage.marketId) !== selectedMarketId) {
    return null;
  }

  const currentMarketDepth = parsedMessage.currentMarketDepth;
  if (!isObject(currentMarketDepth)) {
    return null;
  }

  return {
    bids: aggregateOrderDepth(currentMarketDepth.bids, "bid"),
    asks: aggregateOrderDepth(currentMarketDepth.asks, "ask"),
  };
}

function aggregateOrderDepth(value: unknown, side: "bid" | "ask") {
  if (!Array.isArray(value)) {
    return [];
  }

  const quantityByPrice = new Map<number, number>();

  for (const order of value) {
    if (!isObject(order)) continue;

    const price = numberFrom(order.price);
    const quantity = numberFrom(order.quantity);
    const filled = numberFrom(order.filled) ?? 0;

    if (price === undefined || quantity === undefined) continue;

    const remaining = quantity - filled;
    if (remaining <= 0) continue;

    quantityByPrice.set(price, (quantityByPrice.get(price) ?? 0) + remaining);
  }

  let total = 0;
  return Array.from(quantityByPrice.entries())
    .sort(([firstPrice], [secondPrice]) =>
      side === "bid" ? secondPrice - firstPrice : firstPrice - secondPrice,
    )
    .map(([price, quantity]) => {
      total += quantity;
      return {
        price,
        quantity,
        total,
      };
    });
}

function parseDepthLevels(value: unknown): DepthLevel[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((level) => {
    if (!isObject(level)) {
      return [];
    }

    const price = Number(level.price);
    const quantity = Number(level.quantity);
    const total = Number(level.total);

    if (![price, quantity, total].every(Number.isFinite)) {
      return [];
    }

    return [{ price, quantity, total }];
  });
}

function extractAssets(response: unknown): AssetOption[] {
  if (Array.isArray(response)) {
    return response.flatMap(parseAsset);
  }

  if (isObject(response)) {
    return parseAsset(response.asset);
  }

  return [];
}

function parseAsset(value: unknown): AssetOption[] {
  if (!isObject(value)) {
    return [];
  }

  const id = stringFrom(value.id);
  const name = stringFrom(value.name);
  const symbol = stringFrom(value.symbol);

  if (!id || !symbol) {
    return [];
  }

  return [{ id, name: name || symbol, symbol }];
}

function extractMarkets(response: unknown): MarketOption[] {
  if (Array.isArray(response)) {
    return response.flatMap(parseMarket);
  }

  if (isObject(response)) {
    return parseMarket(response.market);
  }

  return [];
}

function parseMarket(value: unknown): MarketOption[] {
  if (!isObject(value)) {
    return [];
  }

  const id = stringFrom(value.id);
  const name = stringFrom(value.name);
  const baseAssetId = stringFrom(value.baseAssetId);
  const quoteAssetId = stringFrom(value.quoteAssetId);

  if (!id) {
    return [];
  }

  return [
    {
      id,
      name: name || id,
      baseAssetId,
      quoteAssetId,
    },
  ];
}

function extractOrders(response: unknown): OrderOption[] {
  if (!isObject(response) || !isObject(response.loopbackResponse)) {
    return [];
  }

  const rawOrdersByMarket = response.loopbackResponse.orders;
  if (!Array.isArray(rawOrdersByMarket)) {
    return [];
  }

  return rawOrdersByMarket.flatMap((marketOrders) => {
    if (!isObject(marketOrders) || !Array.isArray(marketOrders.orders)) {
      return [];
    }

    const marketId = stringFrom(marketOrders.marketId);

    return marketOrders.orders.flatMap((rawOrder) =>
      parseOrder(rawOrder, marketId),
    );
  });
}

function extractCreatedOrder(response: unknown): OrderOption | null {
  if (!isObject(response) || !isObject(response.loopbackResponse)) {
    return null;
  }

  const parsedOrders = parseOrder(response.loopbackResponse.order, undefined);
  return parsedOrders[0] ?? null;
}

function parseOrder(value: unknown, fallbackMarketId?: string): OrderOption[] {
  if (!isObject(value)) {
    return [];
  }

  const orderId = stringFrom(value.orderId);
  if (!orderId) {
    return [];
  }

  const marketId = isObject(value.market)
    ? stringFrom(value.market.id) || fallbackMarketId
    : fallbackMarketId;

  return [
    {
      orderId,
      marketId,
      price: numberFrom(value.price),
      quantity: numberFrom(value.quantity),
      tradeSide: stringFrom(value.tradeSide),
    },
  ];
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[]) {
  const byId = new Map(current.map((item) => [item.id, item]));

  for (const item of incoming) {
    byId.set(item.id, item);
  }

  return Array.from(byId.values());
}

function mergeByOrderId(current: OrderOption[], incoming: OrderOption[]) {
  const byId = new Map(current.map((item) => [item.orderId, item]));

  for (const item of incoming) {
    byId.set(item.orderId, item);
  }

  return Array.from(byId.values());
}

function formatAssetOption(asset: AssetOption) {
  return `${asset.symbol} - ${asset.name}`;
}

function formatMarketOption(market: MarketOption) {
  return `${market.name} - ${market.id}`;
}

function formatOrderOption(order: OrderOption) {
  const parts = [
    order.tradeSide,
    order.marketId,
    order.price === undefined
      ? undefined
      : `price ${formatNumber(order.price)}`,
    order.quantity === undefined
      ? undefined
      : `qty ${formatNumber(order.quantity)}`,
  ].filter(Boolean);

  return `${order.orderId}${parts.length > 0 ? ` - ${parts.join(" / ")}` : ""}`;
}

function stringFrom(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberFrom(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 8,
  }).format(value);
}
