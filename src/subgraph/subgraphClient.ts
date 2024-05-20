// import { ethers } from "ethers";
// import * as fs from "fs";
import { ApolloClient, InMemoryCache } from "@apollo/client";
const subgraphUrl =
  "https://ethereum-mainnet.graph-eu.p2pify.com/2184baaa9cc6711ad7d40dcbe5f2a125/glow-mainnet";

export const subgraphClient = new ApolloClient({
  uri: subgraphUrl,
  //https://api.studio.thegraph.com/query/38401/glow-subgraph-testnet/v0.0.16
  cache: new InMemoryCache(),
  defaultOptions: {
    query: {
      fetchPolicy: "no-cache",
    },
  },
});
