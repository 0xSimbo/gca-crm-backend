import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { FindFirstOwnerById } from "../../db/queries/farm-owners/findFirsOwnertById";
import { createFarmOwner } from "../../db/mutations/farm-owners/createFarmOwner";
import {
  privateEncryptionKeyExample,
  publicEncryptionKeyExample,
} from "../../examples/encryptionKeys";

import { siweParams, siweParamsExample } from "../../handlers/siweHandler";
import { recoverAddressHandler } from "../../handlers/recoverAddressHandler";
import { updateRole } from "../../db/mutations/accounts/updateRole";
import { generateSaltFromAddress } from "../../utils/encryption/generateSaltFromAddress";
import { GetEntityByIdQueryParamSchema } from "../../schemas/shared/getEntityByIdParamSchema";
import { FindFirstById } from "../../db/queries/accounts/findFirstById";

export const CreateFarmOwnerQueryBody = t.Object({
  fields: t.Object({
    encryptedPrivateEncryptionKey: t.String({
      example: privateEncryptionKeyExample,
    }),
    isInstaller: t.Boolean({
      example: false,
    }),
    publicEncryptionKey: t.String({
      example: publicEncryptionKeyExample,
    }),
    firstName: t.String({
      example: "John",
      minLength: 2,
    }),
    lastName: t.String({
      example: "Doe",
      minLength: 2,
    }),
    email: t.String({
      example: "JohnDoe@gmail.com",
      minLength: 2,
    }),
    companyName: t.Nullable(
      t.String({
        example: "John Doe Farms",
      })
    ),
    companyAddress: t.Nullable(
      t.String({
        example: "123 John Doe Street",
      })
    ),
  }),
  recoverAddressParams: t.Object(siweParams),
});

export const farmOwnersRouter = new Elysia({ prefix: "/farmOwners" })
  .get(
    "/byId",
    async ({ query, set }) => {
      if (!query.id) throw new Error("ID is required");
      try {
        const farmOwner = await FindFirstOwnerById(query.id);
        if (!farmOwner) {
          set.status = 404;
          throw new Error("farmOwner not found");
        }

        return farmOwner;
      } catch (e) {
        console.log("[farmOwnersRouter] byId", e);
        throw new Error("Error Occured");
      }
    },
    {
      query: GetEntityByIdQueryParamSchema,
      detail: {
        summary: "Get Farm Owner by ID",
        description: `Get a Farm Owner by ID. If the farmOwner does not exist, it will throw an error.`,
        tags: [TAG.FARM_OWNERS],
      },
    }
  )
  .post(
    "/create-farm-owner",
    async ({ body, set }) => {
      try {
        const wallet = body.recoverAddressParams.wallet;
        const account = await FindFirstById(wallet);
        if (!account) {
          throw new Error("Account not found");
        }

        if (account.farmOwner) {
          throw new Error("Farm Owner already exists");
        }

        if (account.gca) {
          throw new Error("this account is already a gca");
        }

        await updateRole(wallet, "FARM_OWNER");
        const salt = generateSaltFromAddress(wallet);

        await createFarmOwner({
          id: wallet,
          ...body.fields,
          createdAt: new Date(),
          salt,
        });
      } catch (e) {
        console.log("[accountsRouter] create-farm-owner", e);
        throw new Error("Error Occured");
      }
    },
    {
      body: CreateFarmOwnerQueryBody,
      detail: {
        summary: "Create Farm Owner Account",
        description: `Create a Farm Owner account. If the account already exists, it will throw an error.`,
        tags: [TAG.FARM_OWNERS],
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
