# GCA Round Robin Algorithm

## Introduction

GCAs are assigned to solar farms based on a round-robin algorithm. The round-robin algorithm is a simple algorithm that assigns GCAs to solar farms in a circular order. The algorithm is used to ensure that the GCAs are evenly distributed among the solar farms.

We propose the algorithm work like the following.

1. We grab the list of valid GCAs from on-chain. @0xSimbo would change this by getting the gca's who have registered on the crm in the Gcas table instead since assigning a gca which is not on the crm would not make sense i believe since he can't pick it up.
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
the solar farm will be held on standby. A farm cannot be deferred to the same GCA that has already deferred the farm.

- When a GCA defers a solar farm, the `gca_address` field of the solar farm will be updated to the address of the GCA that the farm was deferred to. The deferments field will be updated with the deferment information.

- The deferment information will be stored in the deferments field of the solar farm. The deferments field will be an array of objects that contain the following fields:
  - `from_gca` - the address of the GCA that deferred the solar farm.
  - `to_gca` - the address of the GCA that the solar farm was deferred to.
  - `timestamp` - the timestamp when the solar farm was deferred.
  - `notes` - an array of notes that the GCA can add when deferring the solar farm. // @0xSimbo any particular reason for it to be an array of notes ? or it can be just one note for simplicity reason ?
  - `signature`- signature of the typedData defering the application

### Fields that are needed in the model

- `gca_assigned_timestamp` - timestamp when the GCA was assigned to the solar farm.
- `gca_acceptance_timestamp` - the timestamp when the GCA accepted the assignment.
- `gca_address` - the address of the GCA that was assigned to the solar farm.
  - If the GCA Acceptance timestamp is empty, that means that the GCA that was assigned, has not accepted the assignment.
  - When a GCA defers the farm to another GCA, the GCA address will be the address of the GCA that the farm was deferred to.
  - The record of deferments should be kept in the deferments field.
- `deferments` - `[{from_gca: string, to_gca:string, timestamp: number,notes:string[]}]` - the list of GCAs that the solar farm was deferred to.

NOTE: a `null` value for `gca_assigned_timestamp` means that no GCA has assigned accepted the solar farm.

### Considerations for API Routes

- If a GCA has deferred the solar farm, any new GCA that is assigned to the solar farm, should not be able to defer the solar farm to the GCA that has already deferred the solar farm.
- Only the GCA Assigned can defer the solar farm to another GCA in the API Routes.
- A farm with a `gca_acceptance_timestamp` should not be able to be deferred.
- Before any action in the CRM, we probably want to check on-chain if they're still a GCA.
