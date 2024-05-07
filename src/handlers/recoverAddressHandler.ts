import { ethers } from "ethers";

export const recoverAddressHandler = async (
  message: string,
  signature: string
) => {
  const address = ethers.utils.verifyMessage(message, signature);
  return address;
};
