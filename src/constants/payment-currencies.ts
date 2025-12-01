import { PAYMENT_CURRENCIES as BASE_PAYMENT_CURRENCIES } from "@glowlabs-org/utils/browser";

/**
 * Extended payment currencies that includes "MIXED" for multi-currency payments
 * "MIXED" is used when an application is funded through multiple fraction types (e.g., SGCTL + GLW)
 */
export const PAYMENT_CURRENCIES = [
  ...BASE_PAYMENT_CURRENCIES,
  "MIXED",
] as const;

export type PaymentCurrency = (typeof PAYMENT_CURRENCIES)[number];
