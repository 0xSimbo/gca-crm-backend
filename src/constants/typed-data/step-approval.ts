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

export const applicationCompletedWithPaymentTypes = {
  Application: [
    { name: "applicationId", type: "string" },
    { name: "deadline", type: "uint256" },
    { name: "devices", type: "string[]" }, // array of devices public keys
    { name: "txHash", type: "string" },
    { name: "nonce", type: "string" },
  ],
};
