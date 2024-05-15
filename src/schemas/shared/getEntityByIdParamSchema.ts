import { t } from "elysia";

// using query params
export const GetEntityByIdQueryParamsSchema = t.Object({
  id: t.String({
    minLength: 42,
    maxLength: 42,
  }),
});

// using path params
export const GetEntityByIdPathParamsSchema = t.Object({
  id: t.String({
    minLength: 42,
    maxLength: 42,
  }),
});
