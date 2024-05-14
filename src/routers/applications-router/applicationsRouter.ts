import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { FindFirstById } from "../../db/queries/accounts/findFirstById";
import { siweParams, siweParamsExample } from "../../handlers/siweHandler";
import { GetEntityByIdQueryParamSchema } from "../../schemas/shared/getEntityByIdParamSchema";
import { recoverAddressHandler } from "../../handlers/recoverAddressHandler";
import { createApplication } from "../../db/mutations/applications/createApplication";
import {
  ApplicatonStatusEnum,
  RoundRobinStatusEnum,
} from "../../types/api-types/Application";

export const CreateApplicationQueryBody = t.Object({
  fields: t.Object({
    establishedCostOfPowerPerKWh: t.Number({
      example: 0.12,
      minimum: 0,
    }),
    estimatedKWhGeneratedPerYear: t.Number({
      example: 32,
      minimum: 0,
    }),
    installerId: t.String(),
    address: t.String({
      example: "123 John Doe Street, Phoenix, AZ 85001",
      minLength: 10, // TODO: match in frontend
    }),
    lat: t.Number({
      example: 38.234242,
      minimum: -90,
      maximum: 90,
    }),
    lng: t.Number({
      example: -111.123412,
      minimum: -180,
      maximum: 180,
    }),
  }),
  recoverAddressParams: t.Object(siweParams),
});

export const applicationsRouter = new Elysia({ prefix: "/applications" })
  .get(
    "/byId",
    async ({ query, set }) => {
      if (!query.id) throw new Error("ID is required");
      try {
        const application = await FindFirstById(query.id);
        if (!application) {
          set.status = 404;
          throw new Error("Application not found");
        }

        return application;
      } catch (e) {
        console.log("[applicationsRouter] byId", e);
        throw new Error("Error Occured");
      }
    },
    {
      query: GetEntityByIdQueryParamSchema,
      detail: {
        summary: "Get Application by ID",
        description: `Get Application by ID`,
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .post(
    "/create-application",
    async ({ body, set }) => {
      try {
        const wallet = body.recoverAddressParams.wallet;
        await createApplication({
          userId: wallet,
          ...body.fields,
          establishedCostOfPowerPerKWh:
            body.fields.establishedCostOfPowerPerKWh.toString(),
          estimatedKWhGeneratedPerYear:
            body.fields.estimatedKWhGeneratedPerYear.toString(),
          createdAt: new Date(),
          farmId: null,
          currentStep: 1,
          roundRobinStatus: RoundRobinStatusEnum.waitingToBeAssigned,
          status: ApplicatonStatusEnum.waitingForApproval,
          updatedAt: null,
          contactType: null,
          contactValue: null,
          finalQuotePerWatt: null,
          preInstallVisitDateFrom: null,
          preInstallVisitDateTo: null,
          afterInstallVisitDateFrom: null,
          afterInstallVisitDateTo: null,
          installDate: null,
          paymentTxHash: null,
          finalProtocolFee: null,
          paymentDate: null,
          gcaAssignedTimestamp: null,
          gcaAcceptanceTimestamp: null,
          gcaAddress: null,
        });
      } catch (e) {
        console.log("[applicationsRouter] create-application", e);
        throw new Error("Error Occured");
      }
    },
    {
      body: CreateApplicationQueryBody,
      detail: {
        summary: "Create ",
        description: `Create a`,
        tags: [TAG.APPLICATIONS],
      },
      beforeHandle: async ({
        body: {
          recoverAddressParams: { message, signature, wallet },
        },
        set,
      }) => {
        try {
          const recoveredAddress = await recoverAddressHandler(
            message,
            signature,
            wallet
          );
          if (recoveredAddress !== wallet) {
            return (set.status = 401);
          }
        } catch (error) {
          return (set.status = 401);
        }
      },
    }
  );
