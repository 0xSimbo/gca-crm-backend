export const applicationAcceptedTypes = {
  Application: [
    { name: "applicationId", type: "string" },
    { name: "accepted", type: "bool" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "string" },
  ],
};

export const deferredTypes = {
  Application: [
    { name: "applicationId", type: "string" },
    { name: "accepted", type: "bool" },
    { name: "to", type: "address" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "string" },
  ],
};
