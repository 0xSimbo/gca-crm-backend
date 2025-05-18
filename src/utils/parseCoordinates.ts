/**
 * @notice Parses a coordinate string in the format 'lat° N/S, lng° E/W' to an object
 * @param coord - Coordinate string
 * @return Object with lat/lng or null if invalid
 */
export function parseCoordinates(
  coord: string
): { lat: number; lng: number } | null {
  let match = coord.match(/([\-\d.]+)°\s*([NS]),\s*([\-\d.]+)°\s*([EW])/i);
  if (match) {
    let lat = parseFloat(match[1]);
    let lng = parseFloat(match[3]);
    if (match[2].toUpperCase() === "S") lat = -Math.abs(lat);
    if (match[4].toUpperCase() === "W") lng = -Math.abs(lng);
    if (match[4].toUpperCase() === "E") lng = Math.abs(lng);
    return { lat, lng };
  }
  match = coord.match(/([\-\d.]+)°\s*([NS]),\s*([\-\d.]+)°/i);
  if (match) {
    let lat = parseFloat(match[1]);
    let lng = parseFloat(match[3]);
    if (match[2].toUpperCase() === "S") lat = -Math.abs(lat);
    return { lat, lng };
  }
  return null;
}
