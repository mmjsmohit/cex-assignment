import express from "express";
import type { Request, Response } from "express";
import { OrderStatus, prisma } from "@repo/db";
import bcrypt from "bcrypt";
import jsonwebtoken from "jsonwebtoken";
import authMiddleware from "./middleware";
import { RedisClient } from "bun";
import getLoopbackResponse from "./loopbackResponse";
import { QUEUE_ID } from "./loopbackResponse";
import { randomUUID } from "crypto";

type MarketType = "SPOT" | "PERP";

const JWT_SECRET = process.env.JWT_SECRET;
const publisherClient = new RedisClient(process.env.REDIS_URL);

const app = express();
app.use(express.json());

app.get("/health", async (req, res) => {
  res.status(200).send("OK");
});

app.post("/signup", async (req: Request, res: Response) => {
  const { username, name, password } = req.body;
  // Check if all the values are supplied
  if (!username || !name || !password) {
    return res.status(400).json({
      message: "All fields are required",
    });
  }
  // Hash the password and store it with all other values
  const hashedPassword = bcrypt.hashSync(password, 10);
  try {
    const createdUser = await prisma.user.create({
      data: {
        username: username,
        name: name,
        password: hashedPassword,
      },
    });
    res.status(200).json({
      message: "User created successfully",
      user: createdUser,
    });
  } catch (e) {
    res.status(500).json({
      message: "Some error has occured, please try again later.",
    });
  }
});

app.post("/signin", async (req: Request, res: Response) => {
  const { username, password } = req.body;
  // Check if all the values are supplied
  if (!username || !password) {
    return res.status(400).json({
      message: "All fields are required",
    });
  }

  // Check if the user with the given username exists
  const userCheck = await prisma.user.findFirst({
    where: {
      username: username,
    },
  });

  if (!userCheck) {
    return res.status(400).json({
      message: "No user found with the given username",
    });
  }

  // Check password
  const passwordMatch = await bcrypt.compare(password, userCheck.password);
  if (!passwordMatch) {
    return res.status(400).json({
      message: "Incorrect password",
    });
  }

  // Generate the JWT and return to the user
  const jwt = jsonwebtoken.sign(
    {
      userId: userCheck.id,
    },
    JWT_SECRET!,
  );

  res.status(200).json({
    jwt,
  });
});

/*
    body = {
        type:           "market" | "limit",
        price:          number | null,
        qty:            number,
        market_id:      string,
        side:           "buy" | "sell"
    }

    @returns {
        orderId: string,
        filledQty: number,
        averagePrice
    }
*/

// 50.01

// 500001
app.post("/order", authMiddleware, async (req, res) => {
  const userId = req.userId;
  const {
    price,
    quantity,
    margin,
    leverage,
    market_id,
    trade_side,
    order_type,
    market_type,
  } = req.body;
  let identifier = randomUUID();
  const normalizedTradeSide = String(trade_side).toUpperCase();

  if (
    normalizedTradeSide !== "BUY" &&
    normalizedTradeSide !== "SELL" &&
    normalizedTradeSide !== "SHORT" &&
    normalizedTradeSide !== "LONG"
  ) {
    return res.status(400).json({
      message: "trade_side must be BUY, SELL, LONG or SHORT",
    });
  }

  const market = await prisma.market.findFirst({
    where: {
      id: market_id,
    },
  });

  if (!market) {
    return res.status(404).json({
      message: "Market not found",
    });
  }

  const loopbackResponsePromise = getLoopbackResponse(identifier);
  if (market_type === "SPOT") {
    await publisherClient.send("LPUSH", [
      "incoming-orders",
      JSON.stringify({
        orderId: identifier,
        userId,
        requestType: "create_order",
        price,
        quantity,
        market_id,
        trade_side: normalizedTradeSide,
        order_type,
        market,
        queue_id: QUEUE_ID,
      }),
    ]);
  } else {
    await publisherClient.send("LPUSH", [
      "perp-incoming-orders",
      JSON.stringify({
        orderId: identifier,
        userId,
        requestType: "create_order",
        entryPrice: price,
        quantity,
        market_id,
        trade_side: normalizedTradeSide,
        order_type,
        market,
        margin,
        leverage,
        queue_id: QUEUE_ID,
      }),
    ]);
  }

  const loopbackResponse = await loopbackResponsePromise;
  res.json({
    message: "Order Pushed to Queue Successfully",
    identifier,
    loopbackResponse,
  });
});

// Get all orders for the user
app.get("/orders", authMiddleware, async (req, res) => {
  const userId = req.userId;
  const marketType: MarketType = req.body.marketType;
  let requestId = randomUUID();

  const loopbackResponsePromise = getLoopbackResponse(requestId);

  if (marketType === "SPOT") {
    await publisherClient.send("LPUSH", [
      "incoming-orders",
      JSON.stringify({
        userId,
        identifier: requestId,
        requestType: "get_all_orders",
        queue_id: QUEUE_ID,
      }),
    ]);
  } else {
    await publisherClient.send("LPUSH", [
      "perp-incoming-orders",
      JSON.stringify({
        userId,
        identifier: requestId,
        requestType: "get_all_orders",
        queue_id: QUEUE_ID,
      }),
    ]);
  }
  const loopbackResponse = await loopbackResponsePromise;
  res.json({
    message: "Order Pushed to Queue Successfully",
    requestId,
    loopbackResponse,
  });
});
/*
    returns the status of an order (partially filled, success, cancellled)
    ALSO RETURNS THE INDIVIDUAL FILLS OF THIS ORDER
*/
app.get("/order/:orderId", authMiddleware, async (req, res) => {
  const userId = req.userId;
  const orderId = req.params.orderId;
  const {
    marketType,
  }: {
    marketType: MarketType;
  } = req.body;

  const requestId = randomUUID();
  const loopbackResponsePromise = getLoopbackResponse(requestId);
  if (marketType === "SPOT") {
    await publisherClient.send("LPUSH", [
      "incoming-orders",
      JSON.stringify({
        identifier: requestId,
        userId,
        orderId,
        requestType: "get_order",
        queue_id: QUEUE_ID,
      }),
    ]);
  } else {
    await publisherClient.send("LPUSH", [
      "perp-incoming-orders",
      JSON.stringify({
        identifier: requestId,
        userId,
        orderId,
        requestType: "get_order",
        queue_id: QUEUE_ID,
      }),
    ]);
  }

  const loopbackResponse = await loopbackResponsePromise;
  res.status(200).json({
    message: "Order fetched successfully",
    requestId,
    loopbackResponse,
  });
});

// Delete an order from the orderbook if it is not filled or is partially filled
app.delete("/order/:orderId", authMiddleware, async (req, res) => {
  const userId = req.userId;
  const orderId = req.params.orderId;
  const { market_type } = req.body;

  const requestId = randomUUID();
  const loopbackResponsePromise = getLoopbackResponse(requestId);
  if (market_type === "PERP") {
    await publisherClient.send("LPUSH", [
      "perp-incoming-orders",
      JSON.stringify({
        identifier: requestId,
        userId,
        orderId,
        requestType: "delete_order",
        market_type,
        queue_id: QUEUE_ID,
      }),
    ]);
  } else {
    await publisherClient.send("LPUSH", [
      "incoming-orders",
      JSON.stringify({
        identifier: requestId,
        userId,
        orderId,
        requestType: "delete_order",
        market_type,
        queue_id: QUEUE_ID,
      }),
    ]);
  }

  const loopbackResponse = await loopbackResponsePromise;
  res.status(200).json({
    message: "Order fetched successfully",
    requestId,
    loopbackResponse,
  });
});

// Get the orderbook depth for a given symbol, e.g., SOL/USD
app.get("/depth/:marketId", async (req, res) => {
  const marketId = req.params.marketId;
  const {
    marketType,
  }: {
    marketType: MarketType;
  } = req.body;

  const requestId = randomUUID();
  const loopbackResponsePromise = getLoopbackResponse(requestId);
  // TODO: Probably start using different queues for different tasks

  marketType === "SPOT"
    ? await publisherClient.send("LPUSH", [
        "incoming-orders",
        JSON.stringify({
          identifier: requestId,
          marketId,
          requestType: "get_depth",
          queue_id: QUEUE_ID,
        }),
      ])
    : await publisherClient.send("LPUSH", [
        "perp-incoming-orders",
        JSON.stringify({
          identifier: requestId,
          marketId,
          requestType: "get_depth",
          queue_id: QUEUE_ID,
        }),
      ]);
  console.log(
    `Depth request sent to queue with id: ${requestId} for market ${marketId} and market type ${marketType}`,
  );

  const loopbackResponse = await loopbackResponsePromise;
  res.status(200).json({
    message: "Depth fetched successfully",
    requestId,
    loopbackResponse,
  });
});

// Get all open orders for the user
app.get("/orders/open", authMiddleware, async (req, res) => {
  const userId = req.userId;

  const openOrders = await prisma.orderHistory.findMany({
    where: {
      userId: userId,
      status: OrderStatus.OPEN,
    },
    include: {
      market: true,
    },
  });
  res.status(200).json({
    message: "Open orders fetched successfully",
    openOrders,
  });
});

// Get all fills for the user
app.get("/fills", authMiddleware, async (req, res) => {
  const userId = req.userId;
  const fills = await prisma.fills.findMany({
    where: {
      userId: userId,
    },
  });
  res.status(200).json({
    message: "Fills fetched successfully",
    fills,
  });
});

// Allows the user to add balance to their account
app.post("/balance", authMiddleware, async (req, res) => {
  const { assetAmount, assetId } = req.body;
  const userId = req.userId;
  const asset = await prisma.asset.findFirst({
    where: {
      id: assetId,
    },
  });
  const assetSymbol = asset?.symbol;
  // Push the add-balance to redis queue
  const identifier = randomUUID();
  const loopbackResponsePromise = getLoopbackResponse(identifier);
  await publisherClient.send("LPUSH", [
    "balance",
    JSON.stringify({
      requestType: "add_balance",
      userId,
      assetId,
      assetSymbol,
      assetAmount,
      identifier,
      queue_id: QUEUE_ID,
    }),
  ]);

  const loopbackResponse = await loopbackResponsePromise;
  res.json({
    message: "Balance Added Successfully",
    identifier,
    loopbackResponse,
  });
});

// Add some collateral to a market for perp trading
app.post("/onramp", authMiddleware, async (req, res) => {
  const userId = req.userId;
  const { marketId, amount } = req.body;
  const identifier = randomUUID();
  const loopbackResponsePromise = getLoopbackResponse(identifier);
  await publisherClient.send("LPUSH", [
    "collaterals",
    JSON.stringify({
      requestType: "add_collateral",
      userId,
      marketId,
      amount,
      identifier,
      queue_id: QUEUE_ID,
    }),
  ]);

  const loopbackResponse = await loopbackResponsePromise;
  res.json({
    message: "Balance Added Successfully",
    identifier,
    loopbackResponse,
  });
});

// Gets the user's balance in USD
app.get("/balance/usd", authMiddleware, async (req, res) => {
  const userId = req.userId;
  const identifier = randomUUID();
  const loopbackResponsePromise = getLoopbackResponse(identifier);
  await publisherClient.send("LPUSH", [
    "balance",
    JSON.stringify({
      requestType: "get_usd_balance",
      userId,
      orderId: identifier,
      identifier,
      queue_id: QUEUE_ID,
    }),
  ]);

  const loopbackResponse = await loopbackResponsePromise;
  res.json({
    message: "Balance USD Retrieved Successfully",
    identifier,
    loopbackResponse,
  });
});

// Gets the user's balance in all currencies
app.get("/balance", authMiddleware, async (req, res) => {
  const userId = req.userId;
  const identifier = randomUUID();
  const loopbackResponsePromise = getLoopbackResponse(identifier);

  await publisherClient.send("LPUSH", [
    "balance",
    JSON.stringify({
      requestType: "get_balance",
      userId,
      identifier,
      queue_id: QUEUE_ID,
    }),
  ]);

  const loopbackResponse = await loopbackResponsePromise;
  res.json({
    message: "Balance Retrieved Successfully",
    identifier,
    loopbackResponse,
  });
});

// Gets the available collateral for the user in all markets
app.get("/equity/available", authMiddleware, async (req, res) => {
  const userId = req.userId;
  const identifier = randomUUID();
  const loopbackResponsePromise = getLoopbackResponse(identifier);
  await publisherClient.send("LPUSH", [
    "collaterals",
    JSON.stringify({
      requestType: "get_available_equity",
      userId,
      identifier,
      queue_id: QUEUE_ID,
    }),
  ]);

  const loopbackResponse = await loopbackResponsePromise;
  res.json({
    message: "Equity Fetched Successfully",
    identifier,
    loopbackResponse,
  });
});

// Add a new asset
app.post("/assets", authMiddleware, async (req, res) => {
  const { name, symbol, logo } = req.body;
  if (!name || !symbol || !logo) {
    return res.status(400).json({
      message: "Name, symbol, and logo are required fields",
    });
  }
  const checkAsset = await prisma.asset.findFirst({
    where: { symbol },
  });

  if (checkAsset) {
    return res.status(201).json({
      message: "Asset already exists",
      asset: checkAsset,
    });
  }

  const newAsset = await prisma.asset.create({
    data: {
      name,
      symbol,
      logo,
    },
  });

  res.status(201).json({
    message: "Asset created successfully",
    asset: newAsset,
  });
});

// Get all the assets created
app.get("/assets", authMiddleware, async (req, res) => {
  const assets = await prisma.asset.findMany({
    where: {},
  });
  res.status(200).json(assets);
});

// Get all the existing markets
app.get("/markets", async (req, res) => {
  const markets = await prisma.market.findMany();
  res.status(200).json(markets);
});

// Create a new market
app.post("/markets", authMiddleware, async (req, res) => {
  const { baseAssetId, quoteAssetId } = req.body;
  // Check if a market already exists or not
  const marketCheck = await prisma.market.findFirst({
    where: {
      baseAssetId: baseAssetId,
      quoteAssetId: quoteAssetId,
    },
  });

  if (!!marketCheck) {
    return res.status(201).json({
      message: "Market already exists",
      market: marketCheck,
    });
  }

  // Market does not exist, create one
  // Start by getting both the assets
  const baseAsset = await prisma.asset.findFirst({
    where: {
      id: baseAssetId,
    },
  });
  const quoteAsset = await prisma.asset.findFirst({
    where: {
      id: quoteAssetId,
    },
  });

  if (!baseAsset || !quoteAsset) {
    return res.status(400).json({
      message:
        "Either the base or quote asset not found, please provide correct input",
    });
  }

  // Since both the asset exist and a market does not already exist, finally create the new market
  const newMarket = await prisma.market.create({
    data: {
      name: baseAsset.symbol + "_" + quoteAsset.symbol,
      baseAssetId: baseAsset.id,
      quoteAssetId: quoteAsset.id,
    },
  });

  res.status(200).json({
    message: "A new market has been created successfully.",
    market: newMarket,
  });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port);
