import { t } from "elysia";
import { SiweMessage } from "siwe";

export const siweParams = {
  wallet: t.String({
    example: "0x2e2771032d119fe590FD65061Ad3B366C8e9B7b9",
    minLength: 42,
    maxLength: 42,
  }),
  message: t.String({
    example: "Sign this message to verify your wallet",
    minLength: 1,
  }),
  signature: t.String({
    example: "0x" + "a".repeat(130) + "1b", // 132 characters
    minLength: 132,
    maxLength: 132,
  }),
};

export const siweParamsExample = {
  wallet: "0x2e2771032d119fe590FD65061Ad3B366C8e9B7b9",
  message: "Sign this message to verify your wallet",
  signature: "0x" + "a".repeat(130) + "1b", // 132 characters
};

export const siweHandler = async (message: string, signature: string) => {
  // verify signature before handling the request
  const siwe = new SiweMessage(JSON.parse(message || "{}"));
  const { success } = await siwe.verify({ signature: signature || "" });
  if (!success) {
    throw new Error("Invalid Signature");
  }
  return siwe.address;
};
