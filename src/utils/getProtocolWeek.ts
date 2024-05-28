import { GENESIS_TIMESTAMP } from "../constants/genesis-timestamp";

/**
 * @dev Genesis Timestamp is the timestamp in seconds of the first block of the GLOW Protocol.
 */
export const getProtocolWeek = () => {
  const secondsSinceGenesis = new Date().getTime() / 1000 - GENESIS_TIMESTAMP;
  const weeksSinceGenesis = Math.floor(secondsSinceGenesis / 604800);
  return weeksSinceGenesis;
};
