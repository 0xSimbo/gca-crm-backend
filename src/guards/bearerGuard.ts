import { t } from "elysia";
import { jwtHandler } from "../handlers/jwtHandler";

export const bearerGuard = {
  headers: t.Object({
    authorization: t.TemplateLiteral("Bearer ${string}"),
  }),
  beforeHandle: async ({ headers: { authorization }, set }: any) => {
    if (!authorization) {
      set.status = 401;
      return "Authorization header is required";
    }

    try {
      await jwtHandler(authorization.split(" ")[1]);
    } catch (error) {
      set.status = 401;
      return "Unauthorized";
    }
  },
};
