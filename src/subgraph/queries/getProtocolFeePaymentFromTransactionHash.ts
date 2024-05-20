import { subgraphClient } from "../subgraphClient";
import { gql } from "@apollo/client";
function createQuery(txHash: string) {
  const query = gql` 
    query {
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
  const { data: result } =
    await subgraphClient.query<GetProtocolFeePaymentFromTransactionHashSubgraphResponse>(
      {
        query,
      }
    );
  if (result.donations.length === 0) {
    return null;
  }

  return result
    .donations[0] as GetProtocolFeePaymentFromTransactionHashSubgraphResponseIndividual;
}
