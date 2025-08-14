import { and, eq, isNotNull, not } from "drizzle-orm";
import { db } from "../../db";
import { Gcas, applications } from "../../schema";

export const roundRobinAssignement = async () => {
  if (process.env.NODE_ENV === "staging") {
    return "0xA9A58D16F454A4FA5F7f00Bbe583A86F2C5446dd";
  }
  const latestAssignedApplication = await db.query.applications.findFirst({
    where: and(
      isNotNull(applications.gcaAssignedTimestamp),
      isNotNull(applications.gcaAddress)
    ),
  });
  if (!latestAssignedApplication) {
    const gca = await db.query.Gcas.findFirst();
    if (!gca) {
      throw new Error("No gca found");
    }
    return gca.id;
  }

  if (!latestAssignedApplication.gcaAddress) {
    throw new Error("no gca address found");
  }

  const gca = await db.query.Gcas.findFirst({
    where: not(eq(Gcas.id, latestAssignedApplication.gcaAddress)),
  });
  if (!gca) {
    return latestAssignedApplication.gcaAddress;
  }
  return gca.id;
};
