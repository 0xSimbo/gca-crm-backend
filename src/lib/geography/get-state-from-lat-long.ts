// const state = getStateFromCoordinates(coordinates, stateBoundaries);
// console.log(state); // Output: New York

import { Coordinates, StateCoordinates } from "../../types";
import { stateCoordinates } from "./state-coordinates";

function isInBoundingBox(point: Coordinates, box: StateCoordinates): boolean {
  return (
    point.latitude <= box.northernmost.latitude &&
    point.latitude >= box.southernmost.latitude &&
    point.longitude >= box.westernmost.longitude &&
    point.longitude <= box.easternmost.longitude
  );
}

export function getStateFromCoordinates(
  coordinates: Coordinates
): string | null {
  for (const [state, bounds] of Object.entries(stateCoordinates)) {
    if (isInBoundingBox(coordinates, bounds)) {
      return state;
    }
  }
  return "Alabama";
}
