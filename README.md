# GCA CRM Backend

## Stack

1. Elysia
   - A typesafe API Client
   - The types are bundled into an npm module and reused across projects to guarantee typesafe requests and responses
   - NPM Publishing is handled in CI
2. Postgres
3. Drizzle ORM
4. Redis
   - Used for caching and potentially rate limiting in future
5. Viem / Ethers

## Getting Started

### For API Consumers

You can download the npm module by running

`bun install @glowlabs-org/crm-bindings elysia@1.0.16 @elysiajs/eden@1.0.12`

You can then go to <a href="./eden-client.ts">this example </a> to get a quickstart into consuming the API.

Swagger docs are also available <a href="http://localhost:300/swagger"> here </a>

### For Contributors

1. Set up your environment

```bash
DATABASE_URL="postgresql://postgres:<password>@<host>:<port>/<database>?sslmode=disable"
REDIS_URL=<YOUR_REDIS_URL>
MAINNET_RPC=<YOUR_MAINNET_RPC>
```

Install dependencies
`bun install`

Run the dev server
`bun run dev` 2. Get somewhat familiar with the repository structure

| Index | Folder/File        | Description                                                                                                                                                                                                                                                                                                     |
| ----- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `index.ts`         | Kickoff function that initiates the server.                                                                                                                                                                                                                                                                     |
| 2     | `constants` folder | Contains all constants that are reused through the application                                                                                                                                                                                                                                                  |
| 3     | `routers` folder   | Contains each individual microservice. Routers are grouped by group relevance. For example, all routes regarding rewards go in the `rewards` router. The prefix for a controller can be found in its respective entrypoint file. Utility functions scoped only to the router should be included in this folder. Key routers: `impact-router` (leaderboards, scores), `fractions-router` (delegation/mining), `referral-router` (referral system), `solar-collector-router` (watts captured). |
| 5     | `db` folder        | Contains the `schema` and ORM object for the database                                                                                                                                                                                                                                                           |
| 6.    | `lib` folder       | Includes all utils and helpers that are reused the project. Includes reusable utils for redis, using web3 functions, etc.                                                                                                                                                                                       |
| 7.    | `crons` folder     | Includes all low level code implementation for each respective cron Job. Crons are initialized at the top level in `index.ts`.                                                                                                                                                                                  |

3. Understand the database structure

#### Understanding the database structure

- If adding or removing columns from the database schemas, make sure to first get familiar with `src/db/schema.ts`. This file contains a list of rules to adhere to when making changes to database schemas.
- Generally speaking, keep in mind where decimals are being manipulated and where they are not. For example, usdg rewards and glow rewards are stored with 2 decimals of precision as `sql bigints` due to `sql` size limitations. This pattern is adhered to throughout the codebase.
- Also make sure that before running a database schema change, you run `bun run test`. Some mutations are raw sql for performance and they rely on manually coding the sql fields. An example in `src/crons/update-user-rewards/update-user-rewards-for-week.ts`
- You should generally try to avoid writing raw SQL and use the ORM. If you are writing raw SQL for optimization purposes, make sure to add unit tests that would cause the testing pipeline to break if your mutation would break from the schema change.

#### When To Cache

- **Impact Scoring**: Pre-computed weekly.
- **Regional Power**: Cached per-week in `power_by_region_by_week`. This is critical for the Solar Collector, ensuring that captured watts are calculated using the network state at the exact moment a farm was finalized.

### ☀️ Solar Collector Logic

The Solar Collector tracks a user's "Verified Solar Footprint" by calculating their share of clean energy capacity from onboarded solar farms.

- **Calculation**: For each farm $F$ finalized in week $W$ and region $R$:
  $\text{Watts Captured} = \text{Capacity}(F) \times \frac{\text{Power}(user, R, W)}{\text{Total Network Power}(R, W)}$
- **Power Components**: Power is composed of `Direct Points` (steering/emissions) and `GlowWorth Points` (liquid assets).
- **Temporal Integrity**: The system uses per-week snapshots of power to ensure impact metrics reflect the user's actual participation at the time of deployment.
- **Environmental Impact**: Metrics like "Homes Powered" and "Trees Equivalent" follow standard Solar-Fleet conversion constants (1.17 kW per U.S. home, 0.022 tonnes CO₂/yr per mature tree).
