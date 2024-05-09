import { db } from "../../db";
import { FarmOwners, FarmOwnerType } from "../../schema";

export const createFarmOwner = async (farmOwner: FarmOwnerType) => {
  await db.insert(FarmOwners).values(farmOwner);
  return farmOwner;
};
