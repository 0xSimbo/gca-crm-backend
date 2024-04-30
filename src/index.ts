import { Elysia } from "elysia";
import { exampleRouter } from "./routers/example-router/exampleRouter";
import { swagger } from "@elysiajs/swagger";
import { cors } from "@elysiajs/cors";
import { protocolFeeRouter } from "./routers/protocol-fee-router/protocolFeeRouter";
import { getRedisKey, setRedisKey } from "./lib/redis-client";

const app = new Elysia()
  .use(cors())
  .use(swagger({ autoDarkMode: true, path: "/swagger" }))
  .use(exampleRouter)
  .use(protocolFeeRouter)
  .get("/", () => "Hello Elysia")
  .listen(3000);

console.log(
  `🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`,
);

export type ApiType = typeof app;
