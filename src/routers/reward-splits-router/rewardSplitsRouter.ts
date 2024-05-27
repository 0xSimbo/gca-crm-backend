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
import { incrementApplicationStep } from "../../db/mutations/applications/incrementApplicationStep";
import { updateApplicationStatus } from "../../db/mutations/applications/updateApplicationStatus";
import { updateApplication } from "../../db/mutations/applications/updateApplication";

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
                set.status = 403;
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
              set.status = 403;
              return "Unauthorized";
            }
            if (application.status !== ApplicationStatusEnum.approved) {
              set.status = 403;
              return "Application is not Approved";
            }
            if (
              application.currentStep !==
              ApplicationSteps.inspectionAndPtoDocuments
            ) {
              set.status = 403;
              return "Application is not in the correct step";
            }

            if (application.rewardSplits.length > 0) {
              set.status = 403;
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
  );
