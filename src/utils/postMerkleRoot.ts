import { ethers } from "ethers";

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

const merkleRootPosterAbi = [
  "function postRoot(bytes32 root) external",
  "function getRoot(bytes32 root) external view returns (tuple(uint64 timestamp, address poster))",
];

const merkleRootPosterAddress = process.env.MERKLE_ROOT_CONTRACT_ADDRESS;

export function hashLeaf(declaration: Declaration): string {
  return ethers.utils.solidityKeccak256(
    ["string", "string", "string", "uint256", "address", "bytes"],
    [
      declaration.fullname,
      declaration.latitude,
      declaration.longitude,
      declaration.date,
      declaration.signer,
      declaration.signature,
    ]
  );
}

export async function postMerkleRoot(merkleRoot: string) {
  if (!process.env.PRIVATE_KEY) {
    throw new Error("PRIVATE_KEY is not set");
  }
  const provider = new ethers.providers.StaticJsonRpcProvider({
    url: process.env.MAINNET_RPC_URL!!,
    skipFetchSetup: true,
  });
  const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  // Define the ABI of the MerkleRootPoster contract

  // Instantiate the MerkleRootPoster contract
  const merkleRootPoster = new ethers.Contract(
    merkleRootPosterAddress,
    merkleRootPosterAbi,
    signer
  );

  const rootData = await merkleRootPoster.getRoot("0x" + merkleRoot);
  if (rootData.timestamp.toString() !== "0") {
    throw new Error("Merkle Root already posted");
  }

  // Upload the Merkle Root
  const tx = await merkleRootPoster.postRoot("0x" + merkleRoot);
  const receipt = await tx.wait();

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
          'function hashLeaf(declaration: { fullname: string; latitude: string; longitude: string; date: number; signer: string; signature: string; }): string { return ethers.utils.solidityKeccak256(["string", "string", "string", "uint256", "address", "bytes"], [ declaration.fullname, declaration.latitude, declaration.longitude, declaration.date, declaration.signer, declaration.signature ]); }',
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
