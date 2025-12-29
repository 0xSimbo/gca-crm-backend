interface ParseOptionalBooleanArgs {
  defaultValue?: boolean;
  fieldName?: string;
}

export function parseOptionalBoolean(
  value: unknown,
  args: ParseOptionalBooleanArgs = {}
) {
  const { defaultValue = false, fieldName = "value" } = args;

  if (value === undefined || value === null) return defaultValue;
  if (typeof value === "boolean") return value;

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return defaultValue;
    if (normalized === "true" || normalized === "1" || normalized === "yes")
      return true;
    if (normalized === "false" || normalized === "0" || normalized === "no")
      return false;
  }

  throw new Error(`${fieldName} must be a boolean`);
}


