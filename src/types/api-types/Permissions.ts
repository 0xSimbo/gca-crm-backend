import { PermissionInsertType } from "../../db/schema";

export const permissions: PermissionInsertType[] = [
  {
    name: "Applications Read",
    description: "View applications and their status and details.",
    key: "applications-read",
  },
  {
    name: "Applications Share",
    description: "Share applications with the organization.",
    key: "applications-share",
  },
  {
    name: "Protocol Fee Payment",
    description: "Import protocol fee payments and view them.",
    key: "protocol-fee-payment",
  },
  {
    name: "Edit Reward Split",
    description: "Edit the reward split for a farm",
    key: "edit-reward-split",
  },
];

export const PermissionsEnum = {
  ApplicationsRead: "applications-read",
  ApplicationsEdit: "applications-edit",
  ApplicationsShare: "applications-share",
  ProtocolFeePayment: "protocol-fee-payment",
  EditRewardSplit: "edit-reward-split",
} as const;
