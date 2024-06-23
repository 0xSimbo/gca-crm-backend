import { PermissionInsertType } from "../../db/schema";

export const permissions: PermissionInsertType[] = [
  {
    name: "Documents View",
    description: "View documents, decode them and download them.",
    key: "documents-view",
  },
  {
    name: "Applications View",
    description: "View applications.",
    key: "applications-view",
  },
  {
    name: "Applications Create",
    description: "Create applications on behalf of the organization.",
    key: "applications-create",
  },
  {
    name: "Protocol Fee Payment",
    description: "Pay the protocol fee.",
    key: "protocol-fee-payment",
  },
  {
    name: "Edit Reward Split",
    description: "Edit the reward split for a farm",
    key: "edit-reward-split",
  },
];

export const PermissionsEnum = {
  DocumentsView: "documents-view",
  ApplicationsView: "applications-view",
  ApplicationsCreate: "applications-create",
  ProtocolFeePayment: "protocol-fee-payment",
  EditRewardSplit: "edit-reward-split",
} as const;
