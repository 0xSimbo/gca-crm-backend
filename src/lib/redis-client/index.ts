import { createClient } from "redis";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error("REDIS_URL is not set");
}

type RedisClient = ReturnType<typeof createClient>;
let redisClient: RedisClient | null = null;

async function getRedisClient() {
  if (!redisClient) {
    redisClient = createClient({
      url: redisUrl,
    });

    redisClient.on("error", (err) => {
      console.log("Redis Client Error", err);
      redisClient = null; // Reset client on error to force reconnection on next use
    });

    await redisClient.connect();
  }
  return redisClient;
}

export async function setRedisKey(key: string, value: string, ttl: number) {
  const client = await getRedisClient();
  await client.set(key, value, {
    EX: ttl,
  });
}

export async function getRedisKey<T>(key: string): Promise<T | undefined> {
  const client = await getRedisClient();
  const value = await client.get(key);
  if (value == "") return undefined;
  //If the typeof t is a string, return the string
  try {
    return JSON.parse(value!) as T;
  } catch (e) {}

  try {
    return parseFloat(value!) as unknown as T;
  } catch (e) {}

  if (typeof value === "string") {
    return value as unknown as T;
  }
}
