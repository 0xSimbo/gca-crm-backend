import { forwarderAddresses } from "./addresses";

/**
 * Wallets we control (team/treasury/test wallets/Smart Contract) that must not appear in user leaderboards.
 * Keep these lowercased.
 */
export const ENDOWMENT_WALLET =
  forwarderAddresses.ENDOWMENT_WALLET.toLowerCase();

export const EXCLUDED_LEADERBOARD_WALLETS = [
  "0x6972B05A0c80064fBE8a10CBc2a2FBCF6fb47D6a",
  "0x0b650820dde452b204de44885fc0fbb788fc5e37",
  "0xd5abe236d2f2f5d10231c054e078788ea3447dfc",
  "0x0116da066517f010e59b32274bf18083af34e108",
  "0x6fa8c7a89b22bf3212392b778905b12f3dbaf5c4",
  "0x3d2788a847a6386275776c0551a1ac453efd8028",
  "0xd8cf559B95E51F0aCc97CFE56DA61fe37178DDC9",
  ENDOWMENT_WALLET,
].map((w) => w.toLowerCase());

export const excludedLeaderboardWalletsSet = new Set(
  EXCLUDED_LEADERBOARD_WALLETS
);
