import { t } from "elysia";

export const GetEntityByIdQueryParamSchema = t.Object(
  {
    id: t.String({
      minLength: 42,
      maxLength: 42,
    }),
  },
  {
    examples: [
      {
        id: "0x2e2771032d119fe590FD65061Ad3B366C8e9B7b9",
      },
    ],
  }
);
