export function normalizePrivateKey32Hex(raw: string): `0x${string}` {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    throw new Error("PRIVATE_KEY is empty");
  }

  // Allow either:
  // - "0x" + 64 hex chars
  // - 64 hex chars (no prefix)
  const withPrefix = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    throw new Error(
      "PRIVATE_KEY must be a 32-byte hex string (64 hex chars), optionally prefixed with 0x"
    );
  }
  return withPrefix as `0x${string}`;
}

