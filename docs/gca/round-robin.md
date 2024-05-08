# GCA Round Robin Algorithm

## Introduction

GCAs are assigned to solar farms based on a round-robin algorithm. The round-robin algorithm is a simple algorithm that assigns GCAs to solar farms in a circular order. The algorithm is used to ensure that the GCAs are evenly distributed among the solar farms.

We propose the algorithm work like the following.

1. We grab the list of valid GCAs from on-chain.
2. Each application has a `gca_assigned_timestamp` field that is set to the timestamp when the GCA was assigned.
3. We get the latest application that has a `gca_assigned_timestamp`.
4. We get the next GCA in the list of valid GCAs.
5. We assign the GCA to the solar farm.

### Considerations

- The finding of the latest application and the assignment of the GCA should be atomic in the SQL Transaction.
- If there is only one GCA, only that GCA should be assigned to all the solar farms.
- If this is the first assignment, the first GCA in the list of valid GCAs should be assigned to the solar farm.

```typescript
//Pseudo code
const allGCAs: string[] = await gca.allGCAs();
if (allGCAs.length === 0) {
  throw new Error("No GCAs available");
}
const sqlTx = `
    find latest gcas assigned timestamp and the gca; 
    if not null assign the next gca to the solar farm; 
    if null assign to first in array`;
await db.execute(sqlTx);
```

## Deferments

Once a solar farm is assigned a GCA, the GCA must accept the assignment. The GCA can either accept or defer the assignment. When the GCA defers a solar farm, they will specify which
GCA to hand the solar farm off to. The GCA can defer the solar farm to any other GCA in the list of valid GCAs. If there are no other GCAs available to defer to,
the solar farm will be held on standby.
