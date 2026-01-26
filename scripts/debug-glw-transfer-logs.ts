import { formatUnits, parseAbiItem } from "viem";
import { viemClient } from "../src/lib/web3-providers/viem-client";
import { GENESIS_TIMESTAMP } from "../src/constants/genesis-timestamp";

const GLW_TOKEN =
  "0xf4fbc617a5733eaaf9af08e1ab816b103388d8b6".toLowerCase() as `0x${string}`;

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

interface Args {
  wallet: `0x${string}`;
  startWeek: number;
  endWeek: number;
}

function getArgValue(argv: string[], key: string): string | undefined {
  const idx = argv.indexOf(key);
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

function parseArgs(argv: string[]): Args {
  const walletRaw =
    getArgValue(argv, "--wallet") ?? getArgValue(argv, "-w") ?? "";
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletRaw)) {
    throw new Error(
      "Missing/invalid wallet. Usage: bun run scripts/debug-glw-transfer-logs.ts --wallet 0x... [--startWeek 113] [--endWeek 113]"
    );
  }

  const startWeekRaw = getArgValue(argv, "--startWeek") ?? "113";
  const endWeekRaw = getArgValue(argv, "--endWeek") ?? startWeekRaw;
  const startWeek = Number(startWeekRaw);
  const endWeek = Number(endWeekRaw);
  if (!Number.isFinite(startWeek) || !Number.isFinite(endWeek)) {
    throw new Error("Invalid week numbers.");
  }
  if (endWeek < startWeek) {
    throw new Error("endWeek must be >= startWeek");
  }

  return {
    wallet: walletRaw.toLowerCase() as `0x${string}`,
    startWeek: Math.trunc(startWeek),
    endWeek: Math.trunc(endWeek),
  };
}

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)"
);

function weekToTimestamp(week: number): number {
  return GENESIS_TIMESTAMP + week * 7 * 24 * 60 * 60;
}

async function getBlockTimestamp(blockNumber: bigint): Promise<bigint> {
  const block = await viemClient.getBlock({ blockNumber });
  return block.timestamp;
}

async function findBlockAtOrAfter(targetTs: bigint): Promise<bigint> {
  const latest = await viemClient.getBlock({ blockTag: "latest" });
  let low = 0n;
  let high = latest.number ?? 0n;
  let best = high;
  while (low <= high) {
    const mid = (low + high) / 2n;
    const ts = await getBlockTimestamp(mid);
    if (ts < targetTs) {
      low = mid + 1n;
    } else {
      best = mid;
      if (mid === 0n) break;
      high = mid - 1n;
    }
  }
  return best;
}

async function findBlockAtOrBefore(targetTs: bigint): Promise<bigint> {
  const latest = await viemClient.getBlock({ blockTag: "latest" });
  let low = 0n;
  let high = latest.number ?? 0n;
  let best = 0n;
  while (low <= high) {
    const mid = (low + high) / 2n;
    const ts = await getBlockTimestamp(mid);
    if (ts <= targetTs) {
      best = mid;
      low = mid + 1n;
    } else {
      if (mid === 0n) break;
      high = mid - 1n;
    }
  }
  return best;
}

async function fetchTransferLogs(params: {
  wallet: `0x${string}`;
  fromBlock: bigint;
  toBlock: bigint;
  direction: "from" | "to";
}) {
  const { wallet, fromBlock, toBlock, direction } = params;
  const chunkSize = 5_000n;
  const logs: any[] = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const end = start + chunkSize - 1n > toBlock ? toBlock : start + chunkSize - 1n;
    const args = direction === "from" ? { from: wallet } : { to: wallet };
    const chunk = await viemClient.getLogs({
      address: GLW_TOKEN,
      event: TRANSFER_EVENT,
      args,
      fromBlock: start,
      toBlock: end,
    });
    logs.push(...chunk);
    start = end + 1n;
  }
  return logs;
}

function formatGlw(value: bigint): string {
  return formatUnits(value, 18);
}

async function main() {
  const { wallet, startWeek, endWeek } = parseArgs(process.argv);

  const startTs = BigInt(weekToTimestamp(startWeek));
  const endTs = BigInt(weekToTimestamp(endWeek + 1)); // exclusive end

  console.log(`wallet: ${wallet}`);
  console.log(`weeks: ${startWeek} - ${endWeek}`);
  console.log(`range (utc): ${new Date(Number(startTs) * 1000).toISOString()} -> ${new Date(Number(endTs) * 1000).toISOString()}`);

  console.log("\nlocating block range...");
  const fromBlock = await findBlockAtOrAfter(startTs);
  const toBlock = await findBlockAtOrBefore(endTs);
  console.log(`fromBlock: ${fromBlock}`);
  console.log(`toBlock:   ${toBlock}`);

  console.log("\nreading balances at range endpoints...");
  const balanceStart = (await viemClient.readContract({
    address: GLW_TOKEN,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [wallet],
    blockNumber: fromBlock,
  })) as bigint;
  const balanceEnd = (await viemClient.readContract({
    address: GLW_TOKEN,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [wallet],
    blockNumber: toBlock,
  })) as bigint;
  const balanceNow = (await viemClient.readContract({
    address: GLW_TOKEN,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [wallet],
  })) as bigint;

  console.log(`balance(start): ${formatGlw(balanceStart)} GLW`);
  console.log(`balance(end):   ${formatGlw(balanceEnd)} GLW`);
  console.log(`balance(now):   ${formatGlw(balanceNow)} GLW`);

  console.log("\nfetching Transfer logs...");
  const [logsFrom, logsTo] = await Promise.all([
    fetchTransferLogs({ wallet, fromBlock, toBlock, direction: "from" }),
    fetchTransferLogs({ wallet, fromBlock, toBlock, direction: "to" }),
  ]);

  const all = [...logsFrom, ...logsTo];
  const dedup = new Map<string, any>();
  for (const log of all) {
    const key = `${log.transactionHash}-${log.logIndex}`;
    dedup.set(key, log);
  }

  const logs = Array.from(dedup.values()).sort((a, b) => {
    if (a.blockNumber === b.blockNumber) {
      return Number(a.logIndex) - Number(b.logIndex);
    }
    return a.blockNumber < b.blockNumber ? -1 : 1;
  });

  const blockTsCache = new Map<bigint, bigint>();
  async function getTs(blockNumber: bigint): Promise<bigint> {
    const cached = blockTsCache.get(blockNumber);
    if (cached != null) return cached;
    const ts = await getBlockTimestamp(blockNumber);
    blockTsCache.set(blockNumber, ts);
    return ts;
  }

  let net = 0n;
  console.log(`\n${logs.length} transfers found:`);
  for (const log of logs) {
    const args = log.args as { from: `0x${string}`; to: `0x${string}`; value: bigint };
    const direction = args.to.toLowerCase() === wallet ? "IN" : "OUT";
    const delta = direction === "IN" ? args.value : -args.value;
    net += delta;
    const ts = await getTs(log.blockNumber as bigint);
    const time = new Date(Number(ts) * 1000).toISOString();
    console.log(
      `${direction} ${formatGlw(args.value)} GLW | block ${log.blockNumber} | ${time} | tx ${log.transactionHash}`
    );
  }

  console.log("\nnet change from transfers:", formatGlw(net), "GLW");
  console.log("balance end - start:", formatGlw(balanceEnd - balanceStart), "GLW");
}

main().catch((err) => {
  console.error("❌ Failed:", err);
  process.exit(1);
});
