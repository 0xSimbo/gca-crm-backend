export interface StateCoordinates {
  northernmost: { latitude: number; longitude: number };
  southernmost: { latitude: number; longitude: number };
  westernmost: { latitude: number; longitude: number };
  easternmost: { latitude: number; longitude: number };
}

// Example usage

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface StateBoundary {
  state: string;
  boundary: Coordinates[];
}
