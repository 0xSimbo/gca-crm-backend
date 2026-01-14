# Solar Collector Router

Public endpoints for the **Solar Collector** gamification layer. Users accumulate "Watts" based on their protocol participation and capture power, visualized as virtual solar panels.

## Concepts

### Watts & Panels

**Watts** represent a user's share of the network's solar capacity. As farms are finalized on the protocol, their capacity (in Watts) is distributed to participating users based on their **Capture Power** in that farm's region.

**Panels** are a visual abstraction:

- **1 Panel = 400 Watts**
- Fractional progress toward the next panel is tracked as "ghost progress" (0-100%)

### Capture Power Formula

When a new farm is finalized, users receive a share of its capacity:

\[
\text{WattsReceived}_{User} = \text{FarmCapacity}_{Watts} \times \left( \frac{\text{Power}_{User, Region}}{\sum \text{Power}_{AllUsers, Region}} \right)
\]

Where **Capture Power** for a user in a specific region is:

\[
\text{Power}_{User, Region} = \text{Points}_{Direct} + \text{Points}\_{GlowWorth}
\]

| Component          | Description                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `Points_Direct`    | Region-specific points from inflation rewards, GCTL steering, and vault bonus tied to farms in that region               |
| `Points_GlowWorth` | Worth-based points (from liquid GLW, unclaimed rewards, delegations) distributed proportionally by region emission share |

**Important**: `glowWorthPoints` stored in the cache is already pre-distributed by emission share. The consumption formula is simply `directPoints + glowWorthPoints` (no additional multiplication needed).

### Data Source

Capture Power data is primarily read from the `power_by_region_by_week` table, which stores per-week snapshots of regional power for all wallets. This ensures that when a farm is finalized, the watts captured reflect the user's influence at that specific point in time.

- **Table**: `power_by_region_by_week` (populated by `updatePowerByRegionByWeek` cron)
- **Fallback**: If a weekly snapshot is missing (e.g. before the cron runs or for early weeks), the system falls back to the latest aggregate regional power from `impact_leaderboard_cache_by_region`.

## Endpoints

### `GET /solar-collector/stats`

Returns the wallet's current Solar Collector statistics.

**Query Parameters:**

- `walletAddress` (required): Ethereum address (0x...)

**Response:**

```typescript
{
  totalWatts: number;           // Total Watts captured across all regions
  wattsByRegion: {              // Breakdown by region ID
    [regionId: number]: number;
  };
  panelsByRegion: {             // Whole panels per region
    [regionId: number]: number;
  };
  panels: number;               // Total whole panels (floor(totalWatts / 400))
  ghostProgress: number;        // Progress toward next panel (0-100%)
  streakStatus: {
    weeks: number;              // Current streak length (or streak from previous week if no action yet)
    isActive: boolean;          // Has active streak or multiplier
    atRisk: boolean;            // Had streak last week but no action this week yet
    multiplier: number;         // Current total multiplier
  };
  weeklyHistory: Array<{        // Historical capture trend
    weekNumber: number;
    wattsCaptured: number;
    cumulativeWatts: number;
    regionalShare: Record<number, { sharePercent: number; wattsCaptured: number }>;
  }>;
}
```

**Streak Logic:**

- `weeks`: Shows the current streak count. If the user has taken an "impact action" (increased delegation or bought a miner) **this week**, shows the updated streak. Otherwise, shows the streak from the previous week (still valid until the week ends).
- `atRisk`: True if the user had a streak at the end of last week but hasn't taken action this week yet. This signals "take action to maintain your streak!"
- `isActive`: True if streak > 0 or multiplier > 1

### `GET /solar-collector/unseen-drops`

Returns recent farm drops (last 7 days) for notification purposes.

**Query Parameters:**

- `walletAddress` (required): Ethereum address

**Response:**

```typescript
{
  unseenDrops: Array<{
    id: number;
    farmId: string;
    farmName: string;
    wattsCaptured: number;
    timestamp: Date;
  }>;
}
```

**Note**: This is a stateless implementation. The frontend should handle "seen" state in localStorage.

### `POST /solar-collector/mark-drops-seen`

Placeholder endpoint for marking drops as seen. Currently a no-op since seen state is handled client-side.

**Body:**

```typescript
{
  walletAddress: string;
  dropIds: number[];
}
```

## How Watts Are Calculated

The `computeTotalWattsCaptured` function in `helpers/compute-watts.ts`:

1. **Fetch finalized farms**: Queries all farms with a `protocolFeePaymentHash` (V2 farms starting from week 97).

2. **Get weekly snapshots**: For each week a farm was finalized, the system queries the `power_by_region_by_week` table for that specific week and region.

3. **Fallback to Aggregate**: If no weekly snapshot exists, the system uses the latest aggregate power from `impact_leaderboard_cache_by_region` as a high-quality approximation.

4. **Compute power per region**:

   ```typescript
   const userPower = userDirectPoints + userGlowWorthPoints;
   ```

   Note: `glowWorthPoints` is already distributed by emission share in the cache.

5. **Compute total network power per region**: Sum of all wallets' power in that region

6. **Calculate watts share**:

   ```typescript
   for (const farm of farmsInRegion) {
     const capacityWatts = parseCapacityFromSystemWattageOutput(farm);
     regionWatts += capacityWatts * (userPower / totalNetworkPower);
   }
   ```

7. **Aggregate**: Sum across all regions for `totalWatts`

## Cache Dependencies

| Cache Table                          | Updated By                                 | Schedule                 |
| ------------------------------------ | ------------------------------------------ | ------------------------ |
| `power_by_region_by_week`            | `Update Power By Region By Week` cron      | Weekly, Sunday 01:00 UTC |
| `impact_leaderboard_cache_by_region` | `update-impact-leaderboard-by-region` cron | Weekly, Sunday 01:00 UTC |

**Manual refresh:**

```bash
curl http://localhost:3005/trigger-power-by-region-by-week-cron
curl http://localhost:3005/trigger-impact-leaderboard-by-region-cron
```

## Example Usage

```typescript
// Fetch Solar Collector stats for a wallet
const response = await fetch(
  `${baseUrl}/solar-collector/stats?walletAddress=0x1234...`
);
const stats = await response.json();

console.log(`Total Watts: ${stats.totalWatts}`);
console.log(`Panels: ${stats.panels}`);
console.log(`Progress to next panel: ${stats.ghostProgress.toFixed(1)}%`);

if (stats.streakStatus.atRisk) {
  console.log("⚠️ Your streak is at risk! Take action to maintain it.");
}
```

## Related Files

- `src/routers/impact-router/helpers/impact-score.ts` - Computes region breakdown with `includeRegionBreakdown: true`
- `src/crons/update-impact-leaderboard-by-region/` - Weekly cron populating the cache
- `src/db/schema.ts` - `impactLeaderboardCacheByRegion` table definition
