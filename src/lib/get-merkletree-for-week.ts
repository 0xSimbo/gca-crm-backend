export type GetMerkleTreeFromRootResponse = {
  merkleTree: {
    address: `0x${string}`;
    glowWeight: string;
    usdcWeight: string;
  }[];
};

export const getMerkleTreeForWeek = async (
  weekNumber: number,
): Promise<GetMerkleTreeFromRootResponse> => {
  const fetchRoute = `https://pub-7e0365747f054c9e85051df5f20fa815.r2.dev/week-${weekNumber}/merkletree.json`;
  const res = await fetch(fetchRoute);
  const merkleTree = (await res.json()) as MerkleTreeApiResponse[];
  const cleanedMerkleTree = merkleTree.map((leaf) => {
    if (!leaf.address && !leaf.wallet)
      throw new Error("No address or wallet found in the merkle tree");
    if (!leaf.usdcWeight && !leaf.usdgWeight)
      throw new Error("No USDC or USDG weight found in the merkle tree");
    if (!leaf.glowWeight)
      throw new Error("No Glow weight found in the merkle tree");

    return {
      address: (leaf.address || leaf.wallet) as `0x${string}`,
      glowWeight: leaf.glowWeight,
      usdcWeight: leaf.usdcWeight || leaf.usdgWeight || "0",
    };
  });

  return {
    merkleTree: cleanedMerkleTree,
  };
};

type MerkleTreeApiResponse = {
  address?: string;
  wallet?: string;
  glowWeight: string;
  usdcWeight?: string;
  usdgWeight?: string;
};
