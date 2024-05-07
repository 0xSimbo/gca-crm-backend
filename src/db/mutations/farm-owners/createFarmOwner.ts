import { db } from "../../db";
import { farmOwners, farmOwnerType } from "../../schema";

export const createFarmOwner = async (farmOwner: farmOwnerType) => {
  await db.insert(farmOwners).values(farmOwner);
  return farmOwner;
};
