import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { siweParams } from "../../handlers/siweHandler";
import {
  GetEntityByIdPathParamsSchema,
  GetEntityByIdQueryParamsSchema,
} from "../../schemas/shared/getEntityByIdParamSchema";
import { recoverAddressHandler } from "../../handlers/recoverAddressHandler";
import { createApplication } from "../../db/mutations/applications/createApplication";
import {
  ApplicationStatusEnum,
  RoundRobinStatusEnum,
} from "../../types/api-types/Application";
import { FindFirstApplicationById } from "../../db/queries/applications/findFirstApplicationById";
import { findAllApplicationsByUserId } from "../../db/queries/applications/findAllApplicationsByUserId";

export const CreateApplicationQueryBody = t.Object({
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
});

export const applicationsRouter = new Elysia({ prefix: "/applications" })
  .get(
    "/byId",
    async ({ query, set }) => {
      if (!query.id) throw new Error("ID is required");
      try {
        const application = await FindFirstApplicationById(query.id);
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
      query: GetEntityByIdQueryParamsSchema,
      detail: {
        summary: "Get Application by ID",
        description: `Get Application by ID`,
        tags: [TAG.APPLICATIONS],
      },
      beforeHandle: async ({ params, set }) => {
        //TODO: guard route to only allow user to see their own applications or to be a GCA
      },
    }
  )
  .get(
    "/all-by-user-id/:id",
    async ({ params: { id }, set }) => {
      if (!id) throw new Error("userId is required");
      try {
        const applications = await findAllApplicationsByUserId(id);

        return applications;
      } catch (e) {
        console.log("[applicationsRouter] byId", e);
        throw new Error("Error Occured");
      }
    },
    {
      query: GetEntityByIdPathParamsSchema,
      detail: {
        summary: "Get Applications by userId",
        description: `Get Applications by userId`,
        tags: [TAG.APPLICATIONS],
      },
      beforeHandle: async ({ params, set }) => {
        //TODO: guard route to only allow user to see their own applications or to be a GCA
      },
    }
  )
  .post(
    "/create-application",
    async ({ body, set }) => {
      try {
        // const wallet = body.recoverAddressParams.wallet; redo get wallet from next-auth-jwt
        await createApplication({
          userId: "0x18a0ba01bbec4aa358650d297ba7bb330a78b073", //TODO: get from next-auth-jwt
          ...body,
          establishedCostOfPowerPerKWh:
            body.establishedCostOfPowerPerKWh.toString(),
          estimatedKWhGeneratedPerYear:
            body.estimatedKWhGeneratedPerYear.toString(),
          createdAt: new Date(),
          farmId: null,
          currentStep: 1,
          roundRobinStatus: RoundRobinStatusEnum.waitingToBeAssigned,
          status: ApplicationStatusEnum.waitingForApproval,
          updatedAt: null,
          contactType: null,
          contactValue: null,
          finalQuotePerWatt: null,
          preInstallVisitDateFrom: null,
          preInstallVisitDateTo: null,
          afterInstallVisitDateFrom: null,
          afterInstallVisitDateTo: null,
          installDate: null,
          intallFinishedDate: null,
          paymentTxHash: null,
          finalProtocolFee: null,
          paymentDate: null,
          gcaAssignedTimestamp: null,
          gcaAcceptanceTimestamp: null,
          gcaAddress: null,
        });
        return { message: "success" };
      } catch (e) {
        console.log("[applicationsRouter] create-application", e);
        throw new Error("Error Occured");
      }
    },
    {
      body: CreateApplicationQueryBody,
      detail: {
        summary: "Create an Application",
        description: `Create an Application`,
        tags: [TAG.APPLICATIONS],
      },
      beforeHandle: async ({ body: {}, set }) => {
        //TODO: guard route to only allow users to create applications and verify jwt from next-auth
      },
    }
  );
