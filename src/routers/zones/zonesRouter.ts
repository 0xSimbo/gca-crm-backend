import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { findAllZones } from "../../db/queries/zones/findAllZones";

export const zonesRouter = new Elysia({ prefix: "/zones" }).get(
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
);
