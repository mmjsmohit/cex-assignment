import { OrderStatus, prisma } from "@repo/db";
import { redis } from "bun";

async function saveSnapshotToDB(parsedResult: any) {
  // Check if the orderId is already present in the DB
  const orderCheck = await prisma.orderHistory.findFirst({
    where: {
      id: parsedResult.orderId,
    },
  });

  if (orderCheck) {
    // If the order is already there in the DB, check if all the fills are present
    // const fillCount = orderCheck?.
  } else {
    // Insert the order in DB since it is not present
    return await prisma.orderHistory.create({
      data: {
        id: parsedResult.orderId,
        userId: parsedResult.userId,
        amount: parsedResult.quantity,
        price: parsedResult.price,
        type: "LIMIT", // TODO: Support Market orders too!
        side: parsedResult.tradeSide,
        marketId: parsedResult.market.id,
        status: getOrderStatus(parsedResult),
        timestamp: new Date(parsedResult.createdAt),
        fills: {
          // Map over the array to rename 'quantity' to 'amount'
          create: parsedResult.fills.map((fill: any) => ({
            orderId: fill.orderId,
            price: fill.price,
            amount: fill.quantity,
            filledAt: new Date(fill.filledAt), // Note: wrap in new Date(fill.filledAt) if schema expects DateTime
          })),
        },
      },
    });
  }
}

async function handleRedisResponse() {
  while (true) {
    try {
      const result = await redis.brpop("snapshot-queue", 0);
      const parsedResult = JSON.parse(result?.[1]!);
      console.log(parsedResult);
      await saveSnapshotToDB(parsedResult);
    } catch (err) {
      console.error("Redis listener error:", err);
    }
  }
}

handleRedisResponse();
function getOrderStatus(parsedResult: any): OrderStatus {
  return OrderStatus.FILLED;
}
