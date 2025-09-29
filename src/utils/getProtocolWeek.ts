import { GENESIS_TIMESTAMP } from "../constants/genesis-timestamp";

/**
 * @dev Genesis Timestamp is the timestamp in seconds of the first block of the GLOW Protocol.
 */
export const getProtocolWeek = () => {
  const secondsSinceGenesis = new Date().getTime() / 1000 - GENESIS_TIMESTAMP;
  const weeksSinceGenesis = Math.floor(secondsSinceGenesis / 604800);
  return weeksSinceGenesis;
};

export function getCurrentEpoch(unixSeconds = Date.now() / 1000): number {
  if (unixSeconds < GENESIS_TIMESTAMP) {
    throw new Error("Timestamp cannot be before genesis");
  }
  // Glow epochs are 1-week intervals since genesis.
  const week = 86400 * 7;
  const timeElapsed = Math.floor(unixSeconds - GENESIS_TIMESTAMP);
  if (timeElapsed < 0) {
    throw new Error("Time elapsed cannot be negative");
  }
  const epoch = Math.floor(timeElapsed / week);
  return epoch;
}

export function dateToEpoch(date: Date): number {
  return getCurrentEpoch(date.getTime() / 1000);
}
