# Scripts

This directory contains utility scripts for database queries and operations.

## Running Scripts

All scripts can be run using Bun:

```bash
bun run scripts/<script-name>.ts
```

## Available Scripts

### Batch Solar Panel Identification (Recommended) 🚀

Process images in bulk using OpenAI's Batch API - **50% cheaper** and no rate limits!

#### 1. `batch-identify-solar-panels.ts` - Create Batch Job

Creates a batch job to identify solar panels in all after-install pictures.

**Usage:**

```bash
bun run scripts/batch-identify-solar-panels.ts
```

**Output:**

- Batch ID for tracking
- Estimated cost (50% cheaper than real-time)
- Instructions for next steps

#### 2. `check-batch-status.ts` - Check Status

Check the processing status of your batch job.

**Usage:**

```bash
bun run scripts/check-batch-status.ts <batch_id>
```

**Output:**

- Current status (validating, in_progress, completed, failed)
- Progress statistics
- Completion time (if finished)

#### 3. `retrieve-batch-results.ts` - Get Results & Update DB

Retrieves results and automatically tags the top 3 pictures per application.

**Usage:**

```bash
bun run scripts/retrieve-batch-results.ts <batch_id>
```

**Output:**

- Updates database with `isShowingSolarPanels = true` for best pictures
- Summary statistics
- Detailed JSON results file

---

### `get-farm-name-by-application-id.ts` - Get Farm Name

Look up the farm name associated with a specific application ID.

**Usage:**

```bash
bun run scripts/get-farm-name-by-application-id.ts <application_id>
```

**Output:**

- Farm name for the given application
- Falls back to deterministic star name if no farm is assigned

**Example:**

```bash
bun run scripts/get-farm-name-by-application-id.ts abc-123-xyz
```

---

### `check-sgctl-operations.ts` - Check & Retry SGCTL Operations

Monitor and retry failed SGCTL finalize/refund operations for launchpad-presale fractions.

**Usage:**

```bash
# List all pending/failed SGCTL operations
bun run scripts/check-sgctl-operations.ts

# Retry all pending SGCTL operations
bun run scripts/check-sgctl-operations.ts --retry

# Retry a specific operation by ID
bun run scripts/check-sgctl-operations.ts --id=123
```

**What it does:**

- Lists all failed `finalize` and `refund` operations
- Shows operation details (fraction ID, farm ID, error message, retry count)
- Shows affected fraction status
- Can manually trigger retries (normally runs every 15 minutes via cron)

**When to use:**

- After fixing `CONTROL_API_URL` environment variable
- When SGCTL delegations need to be finalized/refunded manually
- To check status of Control API callbacks

**Requirements:**

- `CONTROL_API_URL` must be set correctly
- `GUARDED_API_KEY` must be configured for Control API communication

---

### `simulate-sgctl-mixed-flow.ts` - SGCTL Mixed Flow Simulator

End-to-end rehearsal of the "**Real-world Scenario: 40% SGCTL + 60% GLW**" (see `docs/fractions/launchpad-presale-sgctl.md`). The script seeds a fresh application, **hits the real Hub API endpoints**, and spawns a lightweight Control API stub so the Hub’s finalize/refund callbacks succeed without needing Control running.

**Usage**

```bash
# Default 40% SGCTL + 60% GLW success path
bun run scripts/simulate-sgctl-mixed-flow.ts

# Explicit scenario (see table below)
bun run scripts/simulate-sgctl-mixed-flow.ts --scenario=<name>
```

**Scenarios**

| `--scenario`      | What it simulates                                                   | Doc reference                                       |
| ----------------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| `mixed-success`   | Partial presale + GLW fills (default)                               | “Real-world Scenario: 40% SGCTL + 60% GLW”          |
| `refund`          | Partial presale + GLW under-fills → SGCTL refunded                  | “Funding Failure Path”                              |
| `sgctl-only`      | Presale alone funds 100% (blocks GLW creation)                      | “Happy Path / Presale Fully Funds Application”      |
| `zero-presale`    | No SGCTL delegates; GLW round raises the full deposit               | “Zero Fill Success Path”                            |
| `multi-retry`     | Sequential GLW attempts + “one active GLW” guard + retry flow       | “Multi-Retry Path (Sequential GLW Attempts)”        |
| `validation`      | Guardrail tests for `/applications/delegate-sgctl` (should-fail)    | Validation edge cases / rounding & auth sections    |

**It does**

- Inserts a throwaway application (foundation wallet as owner/GCA)
- Calls:
  - `POST /fractions/create-launchpad-presale`
  - `POST /applications/delegate-sgctl` (multiple)
  - `GET  /trigger-expire-fractions-cron` (to expire presale + GLW)
  - `POST /applications/publish-application-to-auction`
- Records GLW splits via `recordFractionSplit` to fill (or partially fill) the auction
- Starts a Control API stub listening on `CONTROL_API_URL` so Hub finalize/refund webhooks succeed
- Prints a summary (fraction statuses, farm ID, stub call counts)

**Requirements**

- Hub server running locally (default `http://localhost:3005`)
- Env vars available to BOTH the Hub server and this script:
  - `NEXTAUTH_SECRET`
  - `FOUNDATION_HUB_MANAGER_WALLET`
  - `GUARDED_API_KEY`
  - `CONTROL_API_URL` (point it to `http://localhost:<port>` so the stub can bind)
  - `R2_NOT_ENCRYPTED_FILES_BUCKET_NAME` (Hub needs this to create farms)

> The script mutates your local DB (creates fractions, farm, etc.). Only run against a disposable environment.

---

### `fetch-applications-missing-solar-panel-pictures.ts` (Legacy)

⚠️ **Not recommended** - Use batch processing instead to avoid rate limits.

Real-time processing that analyzes images one by one (slower, rate limited).

**Usage:**

```bash
bun run scripts/fetch-applications-missing-solar-panel-pictures.ts
```

**Requirements:**

- `OPENAI_API_KEY` environment variable must be set
