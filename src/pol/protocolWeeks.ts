import { GENESIS_TIMESTAMP } from "../constants/genesis-timestamp";

export const PROTOCOL_WEEK_SECONDS = 604800;

export function getProtocolWeekForTimestamp(unixSeconds: number): number {
  if (!Number.isFinite(unixSeconds)) throw new Error("Invalid unixSeconds");
  if (unixSeconds < GENESIS_TIMESTAMP) {
    throw new Error("Timestamp cannot be before genesis");
  }
  return Math.floor((unixSeconds - GENESIS_TIMESTAMP) / PROTOCOL_WEEK_SECONDS);
}

export function getProtocolWeekStartTimestamp(weekNumber: number): number {
  if (!Number.isInteger(weekNumber) || weekNumber < 0) {
    throw new Error("Invalid weekNumber");
  }
  return GENESIS_TIMESTAMP + weekNumber * PROTOCOL_WEEK_SECONDS;
}

export function getProtocolWeekEndTimestamp(weekNumber: number): number {
  return getProtocolWeekStartTimestamp(weekNumber) + PROTOCOL_WEEK_SECONDS;
}

export function getCompletedWeekNumber(nowUnixSeconds = Date.now() / 1000) {
  // Current in-progress week should not be treated as "complete".
  return getProtocolWeekForTimestamp(nowUnixSeconds) - 1;
}

