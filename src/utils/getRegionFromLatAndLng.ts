/**
 * @notice Fetches a WattTime API token
 * @param username - WattTime username
 * @param password - WattTime password
 * @return API token string
 */
async function getToken(username: string, password: string): Promise<string> {
  try {
    const response = await fetch("https://api.watttime.org/login", {
      method: "GET",
      headers: {
        Authorization: "Basic " + btoa(`${username}:${password}`),
        Accept: "application/json",
      },
    });
    if (!response.ok)
      throw new Error(
        `WattTime login failed: ${response.status} ${response.statusText}`
      );
    const data = await response.json();
    if (!data.token) throw new Error("WattTime token not found in response");
    return data.token as string;
  } catch (error) {
    throw new Error(
      `Failed to fetch WattTime token: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * @notice Fetches WattTime region info for given coordinates
 
 * @param latitude - Latitude
 * @param longitude - Longitude
 * @return Region info object
 */
export async function getRegionFromLatAndLng(
  latitude: string,
  longitude: string
): Promise<{
  region: string;
  regionFullName: string;
  signalType: string;
}> {
  try {
    if (!process.env.WATT_TIME_USERNAME || !process.env.WATT_TIME_PASSWORD) {
      throw new Error("WattTime username or password not set");
    }
    const token = await getToken(
      process.env.WATT_TIME_USERNAME,
      process.env.WATT_TIME_PASSWORD
    );
    const url = new URL("https://api.watttime.org/v3/region-from-loc");
    url.searchParams.append("latitude", latitude);
    url.searchParams.append("longitude", longitude);
    url.searchParams.append("signal_type", "co2_moer");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    if (!response.ok)
      throw new Error(
        `WattTime region lookup failed: ${response.status} ${response.statusText}`
      );
    const data = await response.json();
    return {
      region: data.region,
      regionFullName: data.region_full_name,
      signalType: data.signal_type,
    };
  } catch (error) {
    console.error("Error getting region from lat and lng", error);
    throw new Error(
      `Failed to fetch WattTime region info: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
