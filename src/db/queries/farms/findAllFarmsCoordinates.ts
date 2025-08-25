import { eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../../db";
import { applications, Devices } from "../../schema";
import { parseCoordinates } from "../../../utils/parseCoordinates";

export const findAllFarmsCoordinates = async () => {
  const farmsCoordinates = await db.query.applications.findMany({
    where: isNotNull(applications.farmId),
    with: {
      enquiryFieldsCRS: true,
      auditFieldsCRS: true,
      zone: {
        with: {
          requirementSet: {
            columns: {
              code: true,
            },
          },
        },
      },
      farm: {
        columns: {
          id: true,
          region: true,
          regionFullName: true,
          signalType: true,
        },
      },
    },
  });

  return farmsCoordinates.map((farm) => ({
    lat: farm.enquiryFieldsCRS?.lat,
    lng: farm.enquiryFieldsCRS?.lng,
    farmId: farm.farm?.id,
    region: farm.farm?.region,
    regionFullName: farm.farm?.regionFullName,
    signalType: farm.farm?.signalType,
  }));
};

export const findAllLegacyFarmsCoordinates = async () => {
  const response = await fetch(
    "https://glow.org/api/audits?omitDocuments=true"
  );
  if (!response.ok) {
    throw new Error("Failed to fetch audits");
  }
  const audits = await response.json();
  const legacyFarmsCoordinates: {
    lat: string;
    lng: string;
    farmId: string;
    region: string;
    regionFullName: string;
    signalType: string;
  }[] = [];
  for (const audit of audits) {
    const coordStr = audit?.summary?.address?.coordinates;

    const parsedCoords = coordStr ? parseCoordinates(coordStr) : null;

    if (!parsedCoords) {
      console.error(
        `Invalid coordinates format for audit ${audit.id} with coordinates ${coordStr}`
      );
      continue;
    }
    const findMatchingFarm = await db.query.Devices.findFirst({
      where: inArray(Devices.shortId, audit.activeShortIds),
      with: {
        farm: {
          columns: {
            id: true,
            region: true,
            regionFullName: true,
            signalType: true,
          },
        },
      },
    });
    if (!findMatchingFarm) {
      console.error(
        `No matching farm found for audit ${audit.activeShortIds.join(
          ","
        )} with coordinates ${parsedCoords}`
      );
      continue;
    } else {
      legacyFarmsCoordinates.push({
        lat: parsedCoords.lat.toString(),
        lng: parsedCoords.lng.toString(),
        farmId: findMatchingFarm.farmId,
        region: findMatchingFarm.farm.region,
        regionFullName: findMatchingFarm.farm.regionFullName,
        signalType: findMatchingFarm.farm.signalType,
      });
    }
  }
  return legacyFarmsCoordinates;
};
