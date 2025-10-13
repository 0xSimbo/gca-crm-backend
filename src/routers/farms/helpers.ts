import { createHash } from "crypto";

import { getAllUniqueNames } from "./generateNames";

export function getDeterministicStarName(seed: string) {
  const names = getAllUniqueNames();
  if (names.length === 0) return undefined;

  const hash = createHash("sha256").update(seed).digest("hex");
  const hashInt = parseInt(hash.slice(0, 12), 16);
  const index = hashInt % names.length;
  return names[index];
}

export function getDeterministicStarNameForApplicationId(
  applicationId: string
) {
  return getDeterministicStarName(applicationId);
}
