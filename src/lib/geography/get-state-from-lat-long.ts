// const state = getStateFromCoordinates(coordinates, stateBoundaries);
// console.log(state); // Output: New York

import { Coordinates } from "../../types";
// import { stateCoordinates } from "./state-coordinates";

// function isInBoundingBox(point: Coordinates, box: StateCoordinates): boolean {
//   return (
//     point.latitude <= box.northernmost.latitude &&
//     point.latitude >= box.southernmost.latitude &&
//     point.longitude >= box.westernmost.longitude &&
//     point.longitude <= box.easternmost.longitude
//   );
// }

function ValidCoordinates(coordinates: Coordinates): boolean {
  return (
    coordinates.latitude >= -90 &&
    coordinates.latitude <= 90 &&
    coordinates.longitude >= -180 &&
    coordinates.longitude <= 180
  );
}

export async function getStateFromCoordinates(coordinates: Coordinates) {
  const isValid = ValidCoordinates(coordinates);
  if (!isValid) {
    throw new Error("Invalid coordinates");
  }
  const requestUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${coordinates.latitude}&lon=${coordinates.longitude}&zoom=18&format=jsonv2`;
  console.log(requestUrl);
  const res = await fetch(requestUrl, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error("Failed to get state from coordinates");
  }
  const data = await res.json();
  return data.address.state;
}
