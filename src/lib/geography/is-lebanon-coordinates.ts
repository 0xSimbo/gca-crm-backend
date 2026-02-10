export function isLebanonCoordinates(latitude: number, longitude: number): boolean {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;

  // Rough bounding box for Lebanon. Good enough to route Lebanon hub quotes
  // away from the US-only region mapper (state -> US-XX).
  // Lat: 33.05..34.80, Lon: 35.10..36.70
  return (
    latitude >= 33.05 &&
    latitude <= 34.8 &&
    longitude >= 35.1 &&
    longitude <= 36.7
  );
}

