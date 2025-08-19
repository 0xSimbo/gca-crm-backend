import { GraphQLClient } from "graphql-request";
const subgraphUrl =
  "https://ethereum-mainnet.graph-eu.p2pify.com/2184baaa9cc6711ad7d40dcbe5f2a125/glow-mainnet";

export const subgraphClient = new GraphQLClient(subgraphUrl, { fetch });
