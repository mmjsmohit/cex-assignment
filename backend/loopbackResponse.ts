import { redis } from "bun";
import { randomUUID } from "crypto";

export const QUEUE_ID = randomUUID();

const resolveMap: Record<string, (data: any) => void> = {};

async function handleRedisResponse() {
  while (true) {
    try {
      const result = await redis.brpop("response-queue-" + QUEUE_ID, 0);
      const parsedResult = JSON.parse(result?.[1]!);
      const identifier = parsedResult.identifier;
      const resolve = resolveMap[identifier];
      if (resolve) {
        // Call the resolve function with the parsed result
        resolve(parsedResult);
        delete resolveMap[identifier];
      }
    } catch (err) {
      console.error("Redis listener error:", err);
    }
  }
}

handleRedisResponse();

export default async function getLoopbackResponse(identifier: string) {
  return new Promise((resolve) => {
    resolveMap[identifier] = resolve;
  });
}
