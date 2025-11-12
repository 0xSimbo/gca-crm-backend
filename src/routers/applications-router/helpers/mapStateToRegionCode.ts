import { allRegions } from "@glowlabs-org/utils/browser";
import { getStateFromCoordinates } from "../../../lib/geography/get-state-from-lat-long";

/**
 * Maps a US state name to its corresponding region code from the SDK
 * @param stateName - The full state name (e.g., "California", "New York")
 * @returns The region code (e.g., "US-CA", "US-NY") or null if not found
 */
export function mapStateToRegionCode(stateName: string): string | null {
  // Normalize the state name for comparison (remove spaces, convert to lowercase)
  const normalizedStateName = stateName.replace(/\s+/g, "").toLowerCase();

  // Find the matching US region
  const matchingRegion = allRegions.find((region) => {
    if (!region.isUs) return false;

    const normalizedRegionName = region.name.replace(/\s+/g, "").toLowerCase();
    return normalizedRegionName === normalizedStateName;
  });

  return matchingRegion ? matchingRegion.code : null;
}

/**
 * Gets the region code for coordinates by first getting the state, then mapping to region code
 * @param latitude - Latitude coordinate
 * @param longitude - Longitude coordinate
 * @returns The region code or null if not found/not US
 */
export async function getRegionCodeFromCoordinates(
  latitude: number,
  longitude: number
): Promise<string | null> {
  try {
    const stateName = await getStateFromCoordinates({ latitude, longitude });

    if (!stateName) {
      return null;
    }

    return mapStateToRegionCode(stateName);
  } catch (error) {
    console.error("Error getting region code from coordinates:", error);
    return null;
  }
}
