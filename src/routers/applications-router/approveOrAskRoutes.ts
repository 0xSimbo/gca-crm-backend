import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { findFirstAccountById } from "../../db/queries/accounts/findFirstAccountById";
import { approveOrAskForChangesCheckHandler } from "../../utils/check-handlers/approve-or-ask-for-changes";
import { recoverAddressHandler } from "../../handlers/recoverAddressHandler";
import {
  stepApprovedTypes,
  stepApprovedWithFinalProtocolFeeTypes,
} from "../../constants/typed-data/step-approval";
import { approveApplicationStep } from "../../db/mutations/applications/approveApplicationStep";
import { updateApplicationStatus } from "../../db/mutations/applications/updateApplicationStatus";
import { ApplicationStatusEnum } from "../../types/api-types/Application";
import { convertKWhToMWh } from "../../utils/format/convertKWhToMWh";
import { updateApplication } from "../../db/mutations/applications/updateApplication";
import { db } from "../../db/db";
import { weeklyProduction, weeklyCarbonDebt } from "../../db/schema";
import {
  ApproveOrAskForChangesQueryBody,
  WeeklyCarbonDebtSchema,
  WeeklyProductionSchema,
} from "./query-schemas";
import { parseUnits } from "ethers";

export const approveOrAskRoutes = new Elysia()
  .post(
    "/enquiry-approve-or-ask-for-changes",
    async (ctx) => {
      const { body, set } = ctx as any;
      const gcaId = (ctx as any).userId as string;
      try {
        const account = await findFirstAccountById(gcaId);
        if (!account) {
          return { errorCode: 404, errorMessage: "Account not found" };
        }

        const errorChecks = await approveOrAskForChangesCheckHandler(
          body.stepIndex,
          body.applicationId,
          body.deadline,
          account
        );
        if (errorChecks.errorCode !== 200 || !errorChecks.data) {
          set.status = errorChecks.errorCode;
          return errorChecks.errorMessage;
        }

        const approvedValues = {
          applicationId: body.applicationId,
          approved: body.approved,
          deadline: body.deadline,
          stepIndex: body.stepIndex,
          // nonce is fetched from user account. nonce is updated for every new next-auth session
        };

        const recoveredAddress = await recoverAddressHandler(
          stepApprovedTypes,
          approvedValues,
          body.signature,
          gcaId
        );

        if (recoveredAddress.toLowerCase() !== account.id.toLowerCase()) {
          set.status = 400;
          return "Invalid Signature";
        }

        if (body.approved) {
          if (!body.auditFees) {
            set.status = 400;
            return "Audit Fees is required in case of approval";
          }

          if (!body.allowedZones || body.allowedZones.length === 0) {
            set.status = 400;
            return "Allowed Zones is required in case of approval";
          }

          await approveApplicationStep(
            body.applicationId,
            account.id,
            body.annotation,
            body.stepIndex,
            body.signature,
            {
              status: ApplicationStatusEnum.draft,
              currentStep: body.stepIndex + 1,
              allowedZones: body.allowedZones,
              auditFees: BigInt(body.auditFees),
            }
          );
        } else {
          await updateApplicationStatus(
            body.applicationId,
            ApplicationStatusEnum.changesRequired
          );
        }
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log(
          "[applicationsRouter] enquiry-approve-or-ask-for-changes",
          e
        );
        throw new Error("Error Occured");
      }
    },
    {
      body: t.Object({
        ...ApproveOrAskForChangesQueryBody,
        allowedZones: t.Array(t.Number(), {
          minItems: 1,
        }),
        auditFees: t.Nullable(
          t.String({
            minLength: 1,
            pattern: "^[0-9]+$", // bigint string with 6 decimals (USDC)
          })
        ),
      }),
      detail: {
        summary: "Gca Approve or Ask for Changes after step submission",
        description: `Approve or Ask for Changes. If the user is not a GCA, it will throw an error. If the deadline is in the past, it will throw an error. If the deadline is more than 10 minutes in the future, it will throw an error.`,
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .post(
    "/pre-install-documents-approve-or-ask-for-changes",
    async (ctx) => {
      const { body, set } = ctx as any;
      const gcaId = (ctx as any).userId as string;
      try {
        const account = await findFirstAccountById(gcaId);
        if (!account) {
          return { errorCode: 404, errorMessage: "Account not found" };
        }

        const errorChecks = await approveOrAskForChangesCheckHandler(
          body.stepIndex,
          body.applicationId,
          body.deadline,
          account
        );
        if (errorChecks.errorCode !== 200 || !errorChecks.data) {
          set.status = errorChecks.errorCode;
          return errorChecks.errorMessage;
        }

        const approvedValues = {
          applicationId: body.applicationId,
          approved: body.approved,
          deadline: body.deadline,
          stepIndex: body.stepIndex,
          // nonce is fetched from user account. nonce is updated for every new next-auth session
        };

        const recoveredAddress = await recoverAddressHandler(
          stepApprovedTypes,
          approvedValues,
          body.signature,
          gcaId
        );

        if (recoveredAddress.toLowerCase() !== account.id.toLowerCase()) {
          set.status = 400;
          return "Invalid Signature";
        }

        if (body.approved) {
          if (!body.finalQuotePerWatt) {
            set.status = 400;
            return "finalQuotePerWatt is required";
          }

          if (!body.revisedKwhGeneratedPerYear) {
            set.status = 400;
            return "revisedKwhGeneratedPerYear is required";
          }

          const protocolFees =
            parseFloat(body.finalQuotePerWatt) *
            parseFloat(convertKWhToMWh(body.revisedKwhGeneratedPerYear)) *
            1e6;

          await approveApplicationStep(
            body.applicationId,
            account.id,
            body.annotation,
            body.stepIndex,
            body.signature,
            {
              status: ApplicationStatusEnum.approved,
              finalQuotePerWatt: body.finalQuotePerWatt,
              revisedEstimatedProtocolFees: protocolFees.toString(),
              revisedKwhGeneratedPerYear: body.revisedKwhGeneratedPerYear,
              revisedCostOfPowerPerKWh: body.revisedCostOfPowerPerKWh,
            }
          );
        } else {
          await updateApplicationStatus(
            body.applicationId,
            ApplicationStatusEnum.changesRequired
          );
        }
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log(
          "[applicationsRouter] pre-install-documents-approve-or-ask-for-changes",
          e
        );
        throw new Error("Error Occured");
      }
    },
    {
      body: t.Object({
        ...ApproveOrAskForChangesQueryBody,
        finalQuotePerWatt: t.Nullable(t.String()),
        revisedKwhGeneratedPerYear: t.Nullable(t.String()),
        revisedCostOfPowerPerKWh: t.Nullable(t.String()),
      }),
      detail: {
        summary: "Gca Approve or Ask for Changes after step submission",
        description: `Approve or Ask for Changes. If the user is not a GCA, it will throw an error. If the deadline is in the past, it will throw an error. If the deadline is more than 10 minutes in the future, it will throw an error.`,
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .post(
    "/pre-install-visit-approve-or-ask-for-changes",
    async (ctx) => {
      const { body, set } = ctx as any;
      const gcaId = (ctx as any).userId as string;
      try {
        const account = await findFirstAccountById(gcaId);
        if (!account) {
          return { errorCode: 404, errorMessage: "Account not found" };
        }

        const errorChecks = await approveOrAskForChangesCheckHandler(
          body.stepIndex,
          body.applicationId,
          body.deadline,
          account
        );

        const application = errorChecks.data;

        if (errorChecks.errorCode !== 200 || !application) {
          set.status = errorChecks.errorCode;
          return errorChecks.errorMessage;
        }

        const approvedValues = {
          applicationId: body.applicationId,
          approved: body.approved,
          deadline: body.deadline,
          stepIndex: body.stepIndex,
          // nonce is fetched from user account. nonce is updated for every new next-auth session
        };

        const recoveredAddress = await recoverAddressHandler(
          stepApprovedTypes,
          approvedValues,
          body.signature,
          gcaId
        );

        if (recoveredAddress.toLowerCase() !== account.id.toLowerCase()) {
          set.status = 400;
          return "Invalid Signature";
        }

        if (body.approved) {
          if (!application.preInstallVisitDate) {
            set.status = 400;
            return "Pre Install Visit Date is not set";
          }

          const now = new Date();
          const today = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate()
          );

          const preInstallVisitDateTime = new Date(
            application.preInstallVisitDate.getFullYear(),
            application.preInstallVisitDate.getMonth(),
            application.preInstallVisitDate.getDate()
          ).getTime();

          if (today.getTime() < preInstallVisitDateTime) {
            set.status = 400;
            return "Pre Install Visit Date is not passed yet";
          }

          await approveApplicationStep(
            body.applicationId,
            account.id,
            body.annotation,
            body.stepIndex,
            body.signature,
            {
              status: ApplicationStatusEnum.draft,
              preInstallVisitDateConfirmedTimestamp: new Date(),
              currentStep: body.stepIndex + 1,
            }
          );
        } else {
          set.status = 400;
          return "Ask for Changes is not allowed for this step.";
        }
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log("[applicationsRouter] gca-assigned-applications", e);
        throw new Error("Error Occured");
      }
    },
    {
      body: t.Object(ApproveOrAskForChangesQueryBody),
      detail: {
        summary:
          "Gca Approve and confirm pre install visit date or Ask for Changes",
        description: `Approve and confirm pre install visit date or Ask for Changes. If the user is not a GCA, it will throw an error. If the deadline is in the past, it will throw an error. If the deadline is more than 10 minutes in the future, it will throw an error.`,
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .post(
    "/inspection-and-pto-approve-or-ask-for-changes",
    async (ctx) => {
      const { body, set } = ctx as any;
      const gcaId = (ctx as any).userId as string;
      try {
        const account = await findFirstAccountById(gcaId);
        if (!account) {
          return { errorCode: 404, errorMessage: "Account not found" };
        }

        const errorChecks = await approveOrAskForChangesCheckHandler(
          body.stepIndex,
          body.applicationId,
          body.deadline,
          account
        );

        const application = errorChecks.data;

        if (errorChecks.errorCode !== 200 || !application) {
          set.status = errorChecks.errorCode;
          return errorChecks.errorMessage;
        }

        let approvedValues: any;
        let recoveredAddress: string;
        if (body.approved) {
          if (body.finalProtocolFee) {
            approvedValues = {
              applicationId: body.applicationId,
              approved: body.approved,
              deadline: body.deadline,
              finalProtocolFee: body.finalProtocolFee,
              stepIndex: body.stepIndex,
              // nonce is fetched from user account. nonce is updated for every new next-auth session
            };
          } else {
            set.status = 400;
            return "Final Protocol Fee is required in case of approval";
          }

          recoveredAddress = await recoverAddressHandler(
            stepApprovedWithFinalProtocolFeeTypes,
            approvedValues,
            body.signature,
            gcaId
          );
        } else {
          approvedValues = {
            applicationId: body.applicationId,
            approved: body.approved,
            deadline: body.deadline,
            stepIndex: body.stepIndex,
            // nonce is fetched from user account. nonce is updated for every new next-auth session
          };

          recoveredAddress = await recoverAddressHandler(
            stepApprovedTypes,
            approvedValues,
            body.signature,
            gcaId
          );
        }

        if (recoveredAddress.toLowerCase() !== account.id.toLowerCase()) {
          set.status = 400;
          return "Invalid Signature";
        }

        if (body.approved) {
          if (!application.afterInstallVisitDate) {
            set.status = 400;
            return "After Install Visit Date is not set";
          }

          const now = new Date();
          const today = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate()
          );
          const afterInstallVisitDateTime = new Date(
            application.afterInstallVisitDate.getFullYear(),
            application.afterInstallVisitDate.getMonth(),
            application.afterInstallVisitDate.getDate()
          ).getTime();

          if (today.getTime() < afterInstallVisitDateTime) {
            set.status = 400;
            return "After Install Visit Date is not passed yet";
          }

          if (!body.weeklyProduction || !body.weeklyCarbonDebt) {
            set.status = 400;
            return "Missing required fields for weekly production and weekly carbon debt";
          }

          const netCarbonCreditEarningWeekly = (
            body.weeklyProduction?.adjustedWeeklyCarbonCredits -
            body.weeklyCarbonDebt?.weeklyTotalCarbonDebt
          ).toString();
          await approveApplicationStep(
            body.applicationId,
            account.id,
            body.annotation,
            body.stepIndex,
            body.signature,
            {
              status: ApplicationStatusEnum.waitingForApproval,
              afterInstallVisitDateConfirmedTimestamp: new Date(),
              currentStep: body.stepIndex + 1,
              finalProtocolFee: parseUnits(body.finalProtocolFee!!, 6),
            },
            {
              applicationId: body.applicationId,
              systemWattageOutput: `${body.weeklyCarbonDebt?.convertToKW.toString()} kW-DC`,
              netCarbonCreditEarningWeekly,
              weeklyTotalCarbonDebt:
                body.weeklyCarbonDebt?.weeklyTotalCarbonDebt?.toString(),
              averageSunlightHoursPerDay:
                body.weeklyProduction?.hoursOfSunlightPerDay?.toString(),
              adjustedWeeklyCarbonCredits:
                body.weeklyProduction?.adjustedWeeklyCarbonCredits?.toString(),
            }
          );

          // --- Insert into weeklyProduction and weeklyCarbonDebt ---
          try {
            await db
              .insert(weeklyProduction)
              .values({
                applicationId: body.applicationId,
                createdAt: new Date(),
                powerOutputMWH:
                  body.weeklyProduction?.powerOutputMWH?.toString(),
                hoursOfSunlightPerDay:
                  body.weeklyProduction?.hoursOfSunlightPerDay?.toString(),
                carbonOffsetsPerMWH:
                  body.weeklyProduction?.carbonOffsetsPerMWH?.toString(),
                adjustmentDueToUncertainty:
                  body.weeklyProduction?.adjustmentDueToUncertainty?.toString(),
                weeklyPowerProductionMWh:
                  body.weeklyProduction?.weeklyPowerProductionMWh?.toString(),
                weeklyCarbonCredits:
                  body.weeklyProduction?.weeklyCarbonCredits?.toString(),
                adjustedWeeklyCarbonCredits:
                  body.weeklyProduction?.adjustedWeeklyCarbonCredits?.toString(),
              } as any)
              .onConflictDoUpdate({
                target: [weeklyProduction.applicationId],
                set: {
                  updatedAt: new Date(),
                  powerOutputMWH:
                    body.weeklyProduction?.powerOutputMWH?.toString(),
                  hoursOfSunlightPerDay:
                    body.weeklyProduction?.hoursOfSunlightPerDay?.toString(),
                  carbonOffsetsPerMWH:
                    body.weeklyProduction?.carbonOffsetsPerMWH?.toString(),
                  adjustmentDueToUncertainty:
                    body.weeklyProduction?.adjustmentDueToUncertainty?.toString(),
                  weeklyPowerProductionMWh:
                    body.weeklyProduction?.weeklyPowerProductionMWh?.toString(),
                  weeklyCarbonCredits:
                    body.weeklyProduction?.weeklyCarbonCredits?.toString(),
                  adjustedWeeklyCarbonCredits:
                    body.weeklyProduction?.adjustedWeeklyCarbonCredits?.toString(),
                },
              });

            await db
              .insert(weeklyCarbonDebt)
              .values({
                applicationId: body.applicationId,
                createdAt: new Date(),
                totalCarbonDebtAdjustedKWh:
                  body.weeklyCarbonDebt?.totalCarbonDebtAdjustedKWh?.toString(),
                convertToKW: body.weeklyCarbonDebt?.convertToKW?.toString(),
                totalCarbonDebtProduced:
                  body.weeklyCarbonDebt?.totalCarbonDebtProduced?.toString(),
                disasterRisk: body.weeklyCarbonDebt?.disasterRisk?.toString(),
                commitmentPeriod:
                  body.weeklyCarbonDebt?.commitmentPeriod?.toString(),
                adjustedTotalCarbonDebt:
                  body.weeklyCarbonDebt?.adjustedTotalCarbonDebt?.toString(),
                weeklyTotalCarbonDebt:
                  body.weeklyCarbonDebt?.weeklyTotalCarbonDebt?.toString(),
              } as any)
              .onConflictDoUpdate({
                target: [weeklyCarbonDebt.applicationId],
                set: {
                  updatedAt: new Date(),
                  totalCarbonDebtAdjustedKWh:
                    body.weeklyCarbonDebt?.totalCarbonDebtAdjustedKWh?.toString(),
                  convertToKW: body.weeklyCarbonDebt?.convertToKW?.toString(),
                  totalCarbonDebtProduced:
                    body.weeklyCarbonDebt?.totalCarbonDebtProduced?.toString(),
                  disasterRisk: body.weeklyCarbonDebt?.disasterRisk?.toString(),
                  commitmentPeriod: body.weeklyCarbonDebt?.commitmentPeriod,
                  adjustedTotalCarbonDebt:
                    body.weeklyCarbonDebt?.adjustedTotalCarbonDebt?.toString(),
                  weeklyTotalCarbonDebt:
                    body.weeklyCarbonDebt?.weeklyTotalCarbonDebt?.toString(),
                },
              });
          } catch (err) {
            set.status = 500;
            return `Failed to upsert weekly production or carbon debt: ${
              err instanceof Error ? err.message : String(err)
            }`;
          }
        } else {
          await updateApplication(body.applicationId, {
            status: ApplicationStatusEnum.changesRequired,
            afterInstallVisitDate: null,
          });
        }
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log(
          "[applicationsRouter] inspection-and-pto-approve-or-ask-for-changes",
          e
        );
        throw new Error("Error Occured");
      }
    },
    {
      body: t.Object({
        ...ApproveOrAskForChangesQueryBody,
        weeklyProduction: t.Nullable(t.Object(WeeklyProductionSchema)),
        weeklyCarbonDebt: t.Nullable(t.Object(WeeklyCarbonDebtSchema)),
        finalProtocolFee: t.Nullable(t.String()),
      }),
      detail: {
        summary:
          "Gca Approve and confirm pre install visit date or Ask for Changes",
        description: `Approve and confirm pre install visit date or Ask for Changes. If the user is not a GCA, it will throw an error. If the deadline is in the past, it will throw an error. If the deadline is more than 10 minutes in the future, it will throw an error.`,
        tags: [TAG.APPLICATIONS],
      },
    }
  );

export type ApproveOrAskRoutes = typeof approveOrAskRoutes;
