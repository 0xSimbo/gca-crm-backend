import { subgraphClient } from "../subgraphClient";
import { gql } from "graphql-request";
function createQuery(txHash: string) {
  const query = gql` 
     {
      donations(where:{
          and: [
        { transactionHash: "${txHash}"},
        {isDonation:true}
      ]   
          
          })
           {
          id,
          amount,
          user {
              id
          }
    }
    }`;
  return query;
}

export type GetProtocolFeePaymentFromTransactionHashSubgraphResponseIndividual =
  {
    id: string;
    amount: string;
    user: {
      id: string;
    };
  };

type GetProtocolFeePaymentFromTransactionHashSubgraphResponse = {
  donations: GetProtocolFeePaymentFromTransactionHashSubgraphResponseIndividual[];
};

export async function getProtocolFeePaymentFromTransactionHash(
  txHash: string
): Promise<GetProtocolFeePaymentFromTransactionHashSubgraphResponseIndividual | null> {
  const query = createQuery(txHash);
  const result =
    await subgraphClient.request<GetProtocolFeePaymentFromTransactionHashSubgraphResponse>(
      query
    );
  if (result.donations.length === 0) {
    return null;
  }

  const res = result
    .donations[0] as GetProtocolFeePaymentFromTransactionHashSubgraphResponseIndividual;
  console.log(res);
  return res;
}
