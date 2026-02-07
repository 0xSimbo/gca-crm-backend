import Decimal from "decimal.js-light";

// Centralized Decimal config so conversions/sqrt are stable.
Decimal.set({ precision: 80, rounding: Decimal.ROUND_FLOOR });

export { Decimal };

