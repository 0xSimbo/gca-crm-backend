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

### `fetch-applications-missing-solar-panel-pictures.ts` (Legacy)

⚠️ **Not recommended** - Use batch processing instead to avoid rate limits.

Real-time processing that analyzes images one by one (slower, rate limited).

**Usage:**

```bash
bun run scripts/fetch-applications-missing-solar-panel-pictures.ts
```

**Requirements:**

- `OPENAI_API_KEY` environment variable must be set
