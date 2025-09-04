import { db } from "../../db";
import { zones } from "../../schema";

export const findAllZones = async () => {
  return db.query.zones.findMany({
    columns: {
      id: true,
      name: true,
      requirementSetId: true,
      createdAt: true,
      isActive: true,
    },
    with: {
      requirementSet: {
        columns: {
          id: true,
          name: true,
          code: true,
          createdAt: true,
        },
      },
    },
  });
};
