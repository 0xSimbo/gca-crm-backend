/* ------------------------------------------------------------------
 *  random-solar-farm-names.ts
 *  – Generates collision‑free, easy‑to‑read names for solar farms.
 *    Author: ChatGPT (o3), 2025‑06‑12
 * ------------------------------------------------------------------ */

/*  ──────────────────────────────────────────────────────────────
    DESCRIPTIVE ADJECTIVES   –  no duplicates with other lists
   ────────────────────────────────────────────────────────────── */
export const adjectives = [
  "Amber",
  "Arcadian",
  "Beacon",
  "Blissful",
  "Breezy",
  "Bright",
  "Calm",
  "Celestial",
  "Clear",
  "Coastal",
  "Crimson",
  "Crystal",
  "Dappled",
  "Diamond",
  "Emerald",
  "Endless",
  "Golden",
  "Grand",
  "Hidden",
  "Highland",
  "Hushed",
  "Ivy",
  "Jubilant",
  "Luminous",
  "Majestic",
  "Mellow",
  "Morning",
  "Nova",
  "Open",
  "Pioneer",
  "Pure",
  "Quiet",
  "Radiant",
  "Rolling",
  "Ruby",
  "Serene",
  "Sheltered",
  "Silent",
  "Silver",
  "Skyward",
  "Soaring",
  "Solstice",
  "Spirited",
  "Starlit",
  "Sun-kissed",
  "Sunny",
  "Tranquil",
  "Verdant",
] as const;

/*  ──────────────────────────────────────────────────────────────
      COLOR TERMS
     ────────────────────────────────────────────────────────────── */
export const colors = [
  "Azure",
  "Bronze",
  "Cerulean",
  "Copper",
  "Coral",
  "Ebony",
  "Fawn",
  "Frost",
  "Garnet",
  "Indigo",
  "Ivory",
  "Jade",
  "Lilac",
  "Marigold",
  "Obsidian",
  "Olive",
  "Pearl",
  "Rose",
  "Russet",
  "Saffron",
  "Sage",
  "Sapphire",
  "Scarlet",
  "Seaglass",
  "Slate",
  "Taupe",
  "Teal",
  "Topaz",
  "Umber",
  "Viridian",
] as const;

/*  ──────────────────────────────────────────────────────────────
      NATURE-INSPIRED NOUNS  (includes Harbor & Prairie)
     ────────────────────────────────────────────────────────────── */
export const natureNouns = [
  "Acres",
  "Arch",
  "Basin",
  "Bay",
  "Bluff",
  "Bloom",
  "Brook",
  "Canyon",
  "Cedar",
  "Cliff",
  "Cove",
  "Crest",
  "Crossing",
  "Delta",
  "Dunes",
  "Eagle",
  "Echo",
  "Falls",
  "Field",
  "Forest",
  "Glen",
  "Gorge",
  "Grove",
  "Harbor", // kept here, removed elsewhere
  "Haven",
  "Hills",
  "Hollow",
  "Horizon",
  "Island",
  "Knoll",
  "Lagoon",
  "Lakes",
  "Ledge",
  "Light",
  "Marsh",
  "Meadow",
  "Mesa",
  "Moors",
  "Orchard",
  "Outpost",
  "Overlook",
  "Pass",
  "Pines",
  "Point",
  "Prairie", // kept here, removed from adjectives
  "Range",
  "Ridge",
  "River",
  "Sanctuary",
  "Shore",
  "Springs",
  "Summit",
  "Terrace",
  "Timber",
  "Trail",
  "Valley",
  "Vista",
  "Well",
  "Wilds",
] as const;

/*  ──────────────────────────────────────────────────────────────
      TECH-FLAVOURED PREFIXES
     ────────────────────────────────────────────────────────────── */
export const techPrefixes = [
  "Helio",
  "Solar",
  "Eco",
  "Grid",
  "Volt",
  "Flux",
  "Photon",
  "Quantum",
  "Nexus",
  "Pulse",
  "Power",
  "Aurora",
  "ClearSky",
] as const;

/* ------------------------- public API function ------------------------- */
/**
 * Returns all possible unique names in a fixed, deterministic (alphabetical) order.
 */
export function getAllUniqueNames(): string[] {
  const names = new Set<string>();
  // 1) Adjective + Nature
  adjectives.forEach((adj) =>
    natureNouns.forEach((noun) => names.add(`${adj} ${noun}`))
  );
  // 2) Color + Nature
  colors.forEach((color) =>
    natureNouns.forEach((noun) => names.add(`${color} ${noun}`))
  );
  // 3) TechPrefix + Nature
  techPrefixes.forEach((prefix) =>
    natureNouns.forEach((noun) => names.add(`${prefix} ${noun}`))
  );
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

export function generateUniqueNames(count: number): string[] {
  const allNames = getAllUniqueNames();
  if (count > allNames.length) {
    throw new Error(
      `Impossible: requested ${count} > ${allNames.length} unique combos available`
    );
  }
  return allNames.slice(0, count);
}

/** Convenience re‑export as default */
export default generateUniqueNames;
