import { t } from "elysia";

export const GetEntityByIdQueryParamSchema = t.Object({
  id: t.String({
    minLength: 42,
    maxLength: 42,
  }),
});
