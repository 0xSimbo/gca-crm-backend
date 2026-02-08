import MerkleTree from "merkletreejs";
import keccak256 from "keccak256";
import { and, desc, eq, gt, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { DeclarationOfIntentionMerkleRoots, applications } from "../db/schema";
import { db } from "../db/db";
import {
  ApplicationStatusEnum,
  ApplicationSteps,
} from "../types/api-types/Application";

import { createAndUploadJsonFile } from "./r2/upload-to-r2";
import { declarationOfIntentionFieldsValueType } from "../db/mutations/applications/createApplication";
import {
  createPublicClient,
  createWalletClient,
  encodePacked,
  http,
  keccak256 as viemKeccak256,
  parseAbi,
} from "viem";
import { mainnet, sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { normalizePrivateKey32Hex } from "./normalizePrivateKey32";

interface Declaration {
  fullname: string;
  latitude: string;
  longitude: string;
  date: number;
  signer: string;
  signature: string;
}

if (!process.env.MERKLE_ROOT_CONTRACT_ADDRESS) {
  throw new Error("MERKLE_ROOT_CONTRACT_ADDRESS is not set");
}

const merkleRootPosterAbi = parseAbi([
  "function postRoot(bytes32 root)",
  "function getRoot(bytes32 root) view returns (uint64 timestamp, address poster)",
]);

const merkleRootPosterAddress = process.env.MERKLE_ROOT_CONTRACT_ADDRESS;

export function hashLeaf(declaration: Declaration): string {
  return viemKeccak256(
    encodePacked(
      ["string", "string", "string", "uint256", "address", "bytes"],
      [
        declaration.fullname,
        declaration.latitude,
        declaration.longitude,
        BigInt(declaration.date),
        declaration.signer as `0x${string}`,
        declaration.signature as `0x${string}`,
      ]
    )
  );
}

export async function postMerkleRoot(merkleRoot: string) {
  if (!process.env.PRIVATE_KEY) {
    throw new Error("PRIVATE_KEY is not set");
  }
  if (!process.env.MAINNET_RPC_URL) {
    throw new Error("MAINNET_RPC_URL is not set");
  }

  const rpcUrl = process.env.MAINNET_RPC_URL;
  const chain = process.env.NODE_ENV === "production" ? mainnet : sepolia;
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const account = privateKeyToAccount(normalizePrivateKey32Hex(process.env.PRIVATE_KEY));
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  });

  // Define the ABI of the MerkleRootPoster contract

  // Instantiate the MerkleRootPoster contract (read and write via viem)
  const contractAddress = merkleRootPosterAddress as `0x${string}`;

  const hexRoot = (
    merkleRoot.startsWith("0x") ? merkleRoot : "0x" + merkleRoot
  ) as `0x${string}`;
  const rootData = (await publicClient.readContract({
    address: contractAddress,
    abi: merkleRootPosterAbi,
    functionName: "getRoot",
    args: [hexRoot],
  })) as any;
  const existingTimestamp: bigint | null = Array.isArray(rootData)
    ? (rootData[0] as bigint)
    : rootData && typeof rootData === "object" && "timestamp" in rootData
    ? (rootData.timestamp as bigint)
    : null;
  if (existingTimestamp != null && existingTimestamp !== BigInt(0)) {
    throw new Error("Merkle Root already posted");
  }

  // Upload the Merkle Root
  const txHash = await walletClient.writeContract({
    address: contractAddress,
    abi: merkleRootPosterAbi,
    functionName: "postRoot",
    args: [hexRoot],
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
  });

  return receipt.transactionHash;
}

export const postMerkleRootHandler = async () => {
  const lastMerkleRootCommitTimestampFind =
    await db.query.DeclarationOfIntentionMerkleRoots.findFirst({
      orderBy: desc(DeclarationOfIntentionMerkleRoots.timestamp),
    });

  let lastMerkleRootCommitTimestamp =
    lastMerkleRootCommitTimestampFind?.timestamp || new Date(0);

  const readyToCommitApplications = await db.query.applications.findMany({
    columns: {
      id: true,
      declarationOfIntentionSignature: true,
      declarationOfIntentionSignatureDate: true,
      declarationOfIntentionFieldsValue: true,
      userId: true,
    },
    where: and(
      or(
        gt(applications.currentStep, ApplicationSteps.enquiry),
        and(
          eq(applications.currentStep, ApplicationSteps.enquiry),
          eq(applications.status, ApplicationStatusEnum.approved)
        )
      ),
      isNotNull(applications.declarationOfIntentionSignature),
      isNotNull(applications.declarationOfIntentionSignatureDate),
      isNotNull(applications.declarationOfIntentionFieldsValue),
      isNull(applications.declarationOfIntentionCommitedOnChainTxHash),
      gt(
        applications.declarationOfIntentionSignatureDate,
        lastMerkleRootCommitTimestamp
      )
    ),
  });

  const declarations = readyToCommitApplications.map((application) => ({
    ...(application.declarationOfIntentionFieldsValue as declarationOfIntentionFieldsValueType),
    signer: application.userId,
    signature: application.declarationOfIntentionSignature!!,
  }));

  if (declarations.length === 0) {
    return {
      message: "No new declarations to commit",
    };
  }

  const leaves = declarations.map((declaration) => hashLeaf(declaration));
  const merkleTree = new MerkleTree(leaves, keccak256, { sortPairs: true });

  const merkleRoot = merkleTree.getRoot().toString("hex");
  const txHash = await postMerkleRoot(merkleRoot);

  const r2Url = await createAndUploadJsonFile(
    process.env.R2_NOT_ENCRYPTED_FILES_BUCKET_NAME!!,
    `declarationOfIntentionMerkleRoots/${merkleRoot}.json`,
    {
      root: merkleRoot,
      metadata: {
        domain: {
          name: "Glow Crm",
          version: "1",
          chainId: 1,
        },
        type: {
          declarationOfIntention: [
            { name: "fullname", type: "string" },
            { name: "latitude", type: "string" },
            { name: "longitude", type: "string" },
            { name: "date", type: "uint256" },
          ],
        },
        hashFunction:
          'function hashLeaf(declaration: { fullname: string; latitude: string; longitude: string; date: number; signer: string; signature: string; }): string { return keccak256(encodePacked(["string", "string", "string", "uint256", "address", "bytes"], [ declaration.fullname, declaration.latitude, declaration.longitude, declaration.date, declaration.signer, declaration.signature ])); }',
      },
      leaves: declarations,
    }
  );

  await db.insert(DeclarationOfIntentionMerkleRoots).values({
    merkleRoot: merkleRoot,
    txHash,
    merkleRootLength: leaves.length,
    applicationIds: readyToCommitApplications.map((a) => a.id),
    timestamp: new Date(),
    r2Url,
  });
  await db
    .update(applications)
    .set({
      declarationOfIntentionCommitedOnChainTxHash: txHash,
    })
    .where(
      inArray(
        applications.id,
        readyToCommitApplications.map((a) => a.id)
      )
    );
  console.log("Merkle root posted:", txHash);
  return {
    message: "txHash: " + txHash,
  };
};
