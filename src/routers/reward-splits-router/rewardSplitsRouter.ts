import { Elysia, t } from "elysia";
import { TAG } from "../../constants";

import { bearer as bearerplugin } from "@elysiajs/bearer";
import { FindFirstApplicationById } from "../../db/queries/applications/findFirstApplicationById";
import { bearerGuard } from "../../guards/bearerGuard";
import { jwtHandler } from "../../handlers/jwtHandler";
import { findFirstAccountById } from "../../db/queries/accounts/findFirstAccountById";
import { findAllRewardSplitsByApplicationId } from "../../db/queries/rewardSplits/findAllRewardSplitsByApplicationId";
import {
  ApplicationStatusEnum,
  ApplicationSteps,
} from "../../types/api-types/Application";
import { createSplits } from "../../db/mutations/reward-splits/createSplits";

import { updateApplication } from "../../db/mutations/applications/updateApplication";
import { findFirstOrganizationApplicationByApplicationId } from "../../db/queries/applications/findFirstOrganizationApplicationByApplicationId";
import { findOrganizationMemberByUserId } from "../../db/queries/organizations/findOrganizationMemberByUserId";
import { PermissionsEnum } from "../../types/api-types/Permissions";
import { findAllUserOrganizations } from "../../db/queries/organizations/findAllUserOrganizations";
import { findAllApplicationsByOrganizationIds } from "../../db/queries/applications/findAllApplicationsByOrganizationIds";
import { findAllApplicationsRewardSplitsByOrganizationIds } from "../../db/queries/rewardSplits/findAllApplicationsRewardSplitsByOrganizationIds";
import { findAllApplicationsByUserId } from "../../db/queries/applications/findAllApplicationsByUserId";
import { findAllApplicationsRewardSplitsByUserId } from "../../db/queries/rewardSplits/findAllApplicationsRewardSplitsByUserId";
import { updateSplitsWithHistory } from "../../db/mutations/reward-splits/updateSplitsWithHistory";

export const rewardSplitsRouter = new Elysia({ prefix: "/rewardsSplits" })
  .use(bearerplugin())
  .guard(bearerGuard, (app) =>
    app
      .resolve(({ headers: { authorization } }) => {
        const { userId } = jwtHandler(authorization.split(" ")[1]);
        return {
          userId,
        };
      })
      .get(
        "/all-by-application-id",
        async ({ query: { id }, set, userId }) => {
          if (!id) throw new Error("applicationId is required");
          try {
            const application = await FindFirstApplicationById(id);
            if (application?.userId !== userId) {
              const account = await findFirstAccountById(userId);
              if (
                !account ||
                (account.role !== "ADMIN" && account.role !== "GCA")
              ) {
                set.status = 401;
                return "Unauthorized";
              }
            }
            const rewardSplits = await findAllRewardSplitsByApplicationId(id);

            return rewardSplits;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[rewardSplitsRouter] /all-by-application-id", e);
            throw new Error("Error Occured");
          }
        },
        {
          query: t.Object({
            id: t.String(),
          }),
          detail: {
            summary: "Get All reward splits by Application ID",
            description: `Get all reward splits by application, if application is not owned by user, it will throw an error if your are not an admin or GCA`,
            tags: [TAG.REWARD_SPLITS],
          },
        }
      )
      .get(
        "/all-by-user-id",
        async ({ set, userId }) => {
          try {
            const allUserOrgUsers = await findAllUserOrganizations(userId);
            const allUserOrgUsersWithEditRewardSplitsPermission =
              allUserOrgUsers.filter((orgUser) =>
                orgUser.role.rolePermissions.find(
                  (p) => p.permission.key === PermissionsEnum.EditRewardSplit
                )
              );

            const allOrgsApplications =
              await findAllApplicationsRewardSplitsByOrganizationIds(
                allUserOrgUsersWithEditRewardSplitsPermission.map(
                  (org) => org.organizationId
                )
              );
            const allUserApplications =
              await findAllApplicationsRewardSplitsByUserId(
                userId,
                allOrgsApplications.map((app) => app.id)
              );
            return allUserApplications.concat(allOrgsApplications);
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[rewardSplitsRouter] /all-by-user-id", e);
            throw new Error("Error Occured");
          }
        },
        {
          detail: {
            summary: "Get All reward splits by User ID",
            description: `Get all reward splits by user.`,
            tags: [TAG.REWARD_SPLITS],
          },
        }
      )
      .post(
        "/create",
        async ({ body, set, userId }) => {
          try {
            const application = await FindFirstApplicationById(
              body.applicationId
            );
            if (!application) {
              set.status = 404;
              return "Application not found";
            }
            if (application.userId !== userId) {
              const organizationApplication =
                await findFirstOrganizationApplicationByApplicationId(
                  body.applicationId
                );

              if (!organizationApplication) {
                set.status = 400;
                return "Unauthorized";
              }

              const isOrganizationOwner =
                organizationApplication.organization.ownerId === userId;

              const organizationMember = await findOrganizationMemberByUserId(
                organizationApplication.organization.id,
                userId
              );

              const isAuthorized =
                isOrganizationOwner ||
                organizationMember?.role.rolePermissions.find(
                  (p) => p.permission.key === PermissionsEnum.EditRewardSplit
                );

              if (!isAuthorized) {
                set.status = 400;
                return "Unauthorized";
              }
            }
            if (application.status !== ApplicationStatusEnum.approved) {
              set.status = 400;
              return "Application is not Approved";
            }
            if (
              application.currentStep !==
              ApplicationSteps.inspectionAndPtoDocuments
            ) {
              set.status = 400;
              return "Application is not in the correct step";
            }

            if (application.rewardSplits.length > 0) {
              set.status = 400;
              return "Reward Splits already created";
            }

            const sumGlow = body.splits.reduce((acc, curr) => {
              return acc + curr.glowSplitPercent;
            }, 0);

            const sumUsdg = body.splits.reduce((acc, curr) => {
              return acc + curr.usdgSplitPercent;
            }, 0);

            if (sumGlow !== 100 || sumUsdg !== 100) {
              set.status = 400;
              return "Sum of the percentages for each token should be 100";
            }

            //TODO: change to atomic transaction
            await createSplits(
              body.splits.map((split) => ({
                walletAddress: split.walletAddress,
                glowSplitPercent: split.glowSplitPercent.toString(),
                usdgSplitPercent: split.usdgSplitPercent.toString(),
                applicationId: body.applicationId,
              }))
            );

            await updateApplication(body.applicationId, {
              currentStep: ApplicationSteps.payment,
              status: ApplicationStatusEnum.waitingForPayment,
            });
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[rewardSplitsRouter] create", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            applicationId: t.String(),
            splits: t.Array(
              t.Object({
                walletAddress: t.String({
                  minLength: 42,
                  maxLength: 42,
                }),
                glowSplitPercent: t.Numeric(),
                usdgSplitPercent: t.Numeric(),
              })
            ),
          }),
          detail: {
            summary: "",
            description: ``,
            tags: [TAG.REWARD_SPLITS],
          },
        }
      )
      .post(
        "/update",
        async ({ body, set, userId }) => {
          try {
            const application = await FindFirstApplicationById(
              body.applicationId
            );
            if (!application) {
              set.status = 404;
              return "Application not found";
            }
            if (application.userId !== userId) {
              const organizationApplication =
                await findFirstOrganizationApplicationByApplicationId(
                  body.applicationId
                );

              if (!organizationApplication) {
                set.status = 400;
                return "Unauthorized";
              }

              const isOrganizationOwner =
                organizationApplication.organization.ownerId === userId;

              const organizationMember = await findOrganizationMemberByUserId(
                organizationApplication.organization.id,
                userId
              );

              const isAuthorized =
                isOrganizationOwner ||
                organizationMember?.role.rolePermissions.find(
                  (p) => p.permission.key === PermissionsEnum.EditRewardSplit
                );

              if (!isAuthorized) {
                set.status = 400;
                return "Unauthorized";
              }
            }

            if (application.status !== ApplicationStatusEnum.completed) {
              set.status = 400;
              return "Application is not Completed";
            }

            if (!application.farmId) {
              set.status = 400;
              return "Farm not found";
            }

            const sumGlow = body.splits.reduce((acc, curr) => {
              return acc + curr.glowSplitPercent;
            }, 0);

            const sumUsdg = body.splits.reduce((acc, curr) => {
              return acc + curr.usdgSplitPercent;
            }, 0);

            if (sumGlow !== 100 || sumUsdg !== 100) {
              set.status = 400;
              return "Sum of the percentages for each token should be 100";
            }

            await updateSplitsWithHistory(
              userId,
              application.id,
              application.farmId,
              body.splits.map((split) => ({
                walletAddress: split.walletAddress,
                glowSplitPercent: split.glowSplitPercent.toString(),
                usdgSplitPercent: split.usdgSplitPercent.toString(),
                applicationId: body.applicationId,
                updatedAt: new Date(),
              }))
            );
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[rewardSplitsRouter] update", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            applicationId: t.String(),
            splits: t.Array(
              t.Object({
                walletAddress: t.String({
                  minLength: 42,
                  maxLength: 42,
                }),
                glowSplitPercent: t.Numeric(),
                usdgSplitPercent: t.Numeric(),
              })
            ),
          }),
          detail: {
            summary: "",
            description: ``,
            tags: [TAG.REWARD_SPLITS],
          },
        }
      )
  );
