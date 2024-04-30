import { Elysia, t, UnwrapSchema } from "elysia";

const BodySchema = t.Object(
  {
    name: t.String(),
    age: t.Number(),
  },
  {
    description: "Expected an username and password",
    examples: [
      {
        name: "John Doe",
        age: 20,
      },
    ],
  }
);

type BodyType = UnwrapSchema<typeof BodySchema>;

export const exampleRouter = new Elysia({ prefix: "/typedBody" })
  .post(
    "/hello",
    ({ body }): BodyType => {
      return {
        name: body.name,
        age: body.age,
      };
    },
    {
      body: BodySchema,
      detail: {
        summary: "This is the summary of the route",
        description: "This route takes in a name and age and returns them",
        tags: ["example", "example"],
      },
    }
  )
  .get(
    "/otherRoute",
    ({ query }): BodyType => {
      return {
        name: query.name,
        age: query.age,
      };
    },
    {
      query: BodySchema,
      detail: {
        summary: "This is the summary of the route with query params",
        description: "This route takes in a name and age and returns them",
        tags: ["example", "example"],
      },
    }
  );
