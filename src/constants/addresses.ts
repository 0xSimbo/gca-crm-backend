import {
  ControlRouter,
  getAddresses as getSDKAddresses,
} from "@glowlabs-org/utils/browser";

let CHAIN_ID = 1;

type Keys =
  | "earlyLiquidity"
  | "governance"
  | "glow"
  | "vetoCouncilContract"
  | "holdingContract"
  | "grantsTreasury"
  | "gcaAndMinerPoolContract"
  | "gcc"
  | "batchCommit"
  | "usdc"
  | "usdg"
  | "impactCatalyst"
  | "carbonCreditAuction";

type ForwarderKeys = "USDC" | "FORWARDER" | "FOUNDATION_WALLET";

// Mainnet addresses
const mainnetAddresses: Record<Keys, `0x${string}`> = {
  earlyLiquidity: "0xD5aBe236d2F2F5D10231c054e078788Ea3447DFc",
  governance: "0x8d01a258bC1ADB728322499E5D84173EA971d665",
  glow: "0xf4fbC617A5733EAAF9af08E1Ab816B103388d8B6",
  vetoCouncilContract: "0xA3A32d3c9a5A593bc35D69BACbe2dF5Ea2C3cF5C",
  holdingContract: "0xd5970622b740a2eA5A5574616c193968b10e1297",
  grantsTreasury: "0x0116DA066517F010E59b32274BF18083aF34e108",
  gcaAndMinerPoolContract: "0x6Fa8C7a89b22bf3212392b778905B12f3dBAF5C4",
  gcc: "0x21C46173591f39AfC1d2B634b74c98F0576A272B",
  batchCommit: "0x33853c50E6D75d6c5543b9E76B9d323d161c2791",
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  usdg: "0xe010ec500720bE9EF3F82129E7eD2Ee1FB7955F2",
  impactCatalyst: "0x552Fbb4E0269fd5036daf72Ec006AAF6C958F4Fa",
  carbonCreditAuction: "0x85fbB04DEBBDEa052a6422E74bFeA57B17e50A80",
};

// Sepolia addresses (testnet)
const sepoliaAddresses: Record<Keys, `0x${string}`> = {
  earlyLiquidity: "0xD5aBe236d2F2F5D10231c054e078788Ea3447DFc",
  governance: "0x8d01a258bC1ADB728322499E5D84173EA971d665",
  glow: "0x2039161fcE4C8e5CF5FE64e17Fd290E8dFF3c9BD",
  vetoCouncilContract: "0xA3A32d3c9a5A593bc35D69BACbe2dF5Ea2C3cF5C",
  holdingContract: "0xd5970622b740a2eA5A5574616c193968b10e1297",
  grantsTreasury: "0x0116DA066517F010E59b32274BF18083aF34e108",
  gcaAndMinerPoolContract: "0x6Fa8C7a89b22bf3212392b778905B12f3dBAF5C4",
  gcc: "0x21C46173591f39AfC1d2B634b74c98F0576A272B",
  batchCommit: "0x33853c50E6D75d6c5543b9E76B9d323d161c2791",
  usdc: "0x93c898be98cd2618ba84a6dccf5003d3bbe40356",
  usdg: "0xda78313A3fF949890112c1B746AB1c75d1b1c17B",
  impactCatalyst: "0x552Fbb4E0269fd5036daf72Ec006AAF6C958F4Fa",
  carbonCreditAuction: "0x85fbB04DEBBDEa052a6422E74bFeA57B17e50A80",
};

if (process.env.NODE_ENV === "production") {
  CHAIN_ID = 1;
} else {
  CHAIN_ID = 11155111;
}

if (!process.env.CONTROL_API_URL) {
  throw new Error("CONTROL_API_URL is not set");
}

// Dynamic address selection based on chain ID
const getAddresses = (): Record<Keys, `0x${string}`> => {
  switch (CHAIN_ID) {
    case 1:
      return mainnetAddresses;
    case 11155111:
      return sepoliaAddresses;
    default:
      console.warn(
        `Unsupported chain ID: ${CHAIN_ID}, falling back to mainnet addresses`
      );
      return mainnetAddresses;
  }
};

export const addresses = getAddresses();
export const forwarderAddresses = getSDKAddresses(CHAIN_ID);

// ---------------------------------------------------------------------------
// Decimals per currency (on-chain token precision)
// ---------------------------------------------------------------------------

export const DECIMALS_BY_CURRENCY: Record<string, number> = {
  USDC: 6,
  USDG: 6,
  GLW: 18,
};
