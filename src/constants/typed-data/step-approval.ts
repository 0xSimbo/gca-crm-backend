export const stepApprovedTypes = {
  Application: [
    { name: "applicationId", type: "string" },
    { name: "approved", type: "bool" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "string" },
    { name: "stepIndex", type: "uint256" },
  ],
};

export const stepApprovedWithFinalProtocolFeeTypes = {
  Application: [
    { name: "applicationId", type: "string" },
    { name: "approved", type: "bool" },
    { name: "deadline", type: "uint256" },
    { name: "finalProtocolFee", type: "string" },
    { name: "nonce", type: "string" },
    { name: "stepIndex", type: "uint256" },
  ],
};
