import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { findAllZones } from "../../db/queries/zones/findAllZones";
import { createZone } from "../../db/mutations/zones/createZone";
import { db } from "../../db/db";
import { requirementSets } from "../../db/schema";

export const zonesRouter = new Elysia({ prefix: "/zones" })
  .get(
    "/all",
    async ({ set }) => {
      try {
        const zones = await findAllZones();
        return zones;
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        set.status = 500;
        return "Internal Server Error";
      }
    },
    {
      detail: {
        summary: "Get all zones",
        description: `Returns all zones with their id, name, requirementSetId, and createdAt and the requirementSet with its id, name, code, and createdAt`,
        tags: [TAG.ZONES],
      },
    }
  )
  .post(
    "/create",
    async ({ body, set, headers }) => {
      try {
        // API key validation
        const apiKey = headers["x-api-key"];
        if (!apiKey) {
          set.status = 400;
          return "API Key is required";
        }
        if (apiKey !== process.env.GUARDED_API_KEY) {
          set.status = 401;
          return "Unauthorized";
        }

        const { name, requirementSetId } = body;

        // Validate that the requirement set exists
        const requirementSet = await db.query.requirementSets.findFirst({
          where: (rs, { eq }) => eq(rs.id, requirementSetId),
        });

        if (!requirementSet) {
          set.status = 400;
          return `Requirement set with ID ${requirementSetId} not found`;
        }

        // Create the new zone
        const newZone = await createZone({
          name,
          requirementSetId,
          isActive: false,
        });

        // Return the created zone with its requirement set
        const createdZone = await db.query.zones.findFirst({
          where: (z, { eq }) => eq(z.id, newZone.id),
        });

        return createdZone;
      } catch (e) {
        if (e instanceof Error) {
          console.error("Error creating zone", e);
          set.status = 400;
          return e.message;
        }
        set.status = 500;
        return "Internal Server Error";
      }
    },
    {
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 255 }),
        requirementSetId: t.Integer({ minimum: 1 }),
      }),
      detail: {
        summary: "Create a new zone",
        description: `Creates a new zone with the specified name and requirement set. Requires API key authentication.`,
        tags: [TAG.ZONES],
      },
    }
  );
