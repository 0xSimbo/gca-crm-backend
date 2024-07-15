import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { findFirstUserById } from "../../db/queries/users/findFirstUserById";
import {
  privateEncryptionKeyExample,
  publicEncryptionKeyExample,
} from "../../examples/encryptionKeys";
import { updateRole } from "../../db/mutations/accounts/updateRole";
import { findFirstAccountById } from "../../db/queries/accounts/findFirstAccountById";
import { createUser } from "../../db/mutations/users/createUser";
import { jwtHandler } from "../../handlers/jwtHandler";
import { bearer as bearerplugin } from "@elysiajs/bearer";
import { bearerGuard } from "../../guards/bearerGuard";
import { GetEntityByIdQueryParamsSchema } from "../../schemas/shared/getEntityByIdParamSchema";
import { createInstaller } from "../../db/mutations/installers/createInstaller";
import { findFirstUserByEmail } from "../../db/queries/users/findFirstUserByEmail";
import { ContactType, contactTypes } from "../../types/api-types/Application";
import { updateUserContactInfos } from "../../db/mutations/users/updateUserContactInfos";
import { getUserFarmsCount } from "../../db/queries/farms/getUserFarmsCount";
import { getUserPendingApplicationsCount } from "../../db/queries/applications/getUserPendingApplicationsCount";
import { getWalletRewards } from "../../db/queries/wallets/getWalletRewards";
import { updateInstaller } from "../../db/mutations/installers/updateInstaller";
import { findFirstInstallerById } from "../../db/queries/installers/findFirstInstallerById";
import { updateUser } from "../../db/mutations/users/updateUser";
import { findFirstDelegatedUserByUserId } from "../../db/queries/gcaDelegatedUsers/findFirstDelegatedUserByUserId";

export const CreateUserQueryBody = t.Object({
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
  phone: t.Nullable(
    t.String({
      example: "123-456-7890",
    })
  ),
});

export const UpdateUserQueryBody = t.Object({
  isInstaller: t.Boolean({
    example: false,
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
  phone: t.Nullable(
    t.String({
      example: "123-456-7890",
    })
  ),
});

export const UpdateUserContactInfosQueryBody = t.Object({
  value: t.String(),
  type: t.String({
    enum: contactTypes,
  }),
});

export const usersRouter = new Elysia({ prefix: "/users" })
  .use(bearerplugin())
  .guard(bearerGuard, (app) =>
    app
      .resolve(({ headers: { authorization } }) => {
        const { userId } = jwtHandler(authorization.split(" ")[1]);
        return {
          userId,
        };
      })
      .post(
        "/create-user",
        async ({ body, set, userId }) => {
          try {
            console.log("create", userId);
            const wallet = userId;
            const account = await findFirstAccountById(userId);
            if (!account) {
              set.status = 404;
              return "Account not found";
            }

            if (account.user) {
              set.status = 409;
              return "User already exists";
            }

            if (account.gca) {
              set.status = 409;
              return "this account is already a gca";
            }

            // check if email already exists
            const emailExists = await findFirstUserByEmail(body.email);
            if (emailExists) {
              set.status = 409;
              return "Email already exists";
            }

            let installerId;

            if (body.isInstaller) {
              if (!body.phone) {
                set.status = 400;
                return "Phone number is required for installer";
              }
              if (!body.companyName) {
                set.status = 400;
                return "Company Name is required for installer";
              }
              installerId = await createInstaller({
                email: body.email,
                companyName: body.companyName,
                phone: body.phone,
                name: `${body.firstName} ${body.lastName}`,
              });
            }

            await createUser({
              id: wallet,
              ...body,
              createdAt: new Date(),
              installerId: installerId || null,
              contactType: "email",
              contactValue: body.email,
            });
            await updateRole(wallet, "USER");
          } catch (e) {
            console.log("[UsersRouter] create-user", e);
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            throw new Error("Error Occured");
          }
        },
        {
          body: CreateUserQueryBody,
          detail: {
            summary: "Create User Account",
            description: `Create a User account. If the account already exists, it will throw an error.`,
            tags: [TAG.USERS],
          },
        }
      )
      .post(
        "/update-user-infos",
        async ({ body, set, userId }) => {
          try {
            const user = await findFirstUserById(userId);
            if (!user) {
              set.status = 404;
              return "User not found";
            }

            // check if email already exists
            const emailExists = await findFirstUserByEmail(body.email);
            if (emailExists && body.email !== user.email) {
              set.status = 409;
              return "Email already exists";
            }

            if (body.isInstaller) {
              if (!body.phone) {
                set.status = 400;
                return "Phone number is required for installer";
              }
              if (!body.companyName) {
                set.status = 400;
                return "Company Name is required for installer";
              }
              if (user.installerId) {
                await updateInstaller(
                  {
                    email: body.email,
                    companyName: body.companyName,
                    phone: body.phone,
                    name: `${body.firstName} ${body.lastName}`,
                  },
                  user.installerId
                );
                await updateUser(
                  {
                    companyAddress: body.companyAddress,
                    companyName: body.companyName,
                    email: body.email,
                    firstName: body.firstName,
                    lastName: body.lastName,
                  },
                  userId
                );
              } else {
                const installerId = await createInstaller({
                  email: body.email,
                  companyName: body.companyName,
                  phone: body.phone,
                  name: `${body.firstName} ${body.lastName}`,
                });
                await updateUser(
                  {
                    companyAddress: body.companyAddress,
                    companyName: body.companyName,
                    email: body.email,
                    firstName: body.firstName,
                    lastName: body.lastName,
                    installerId,
                  },
                  userId
                );
              }
            } else {
              await updateUser(
                {
                  companyAddress: body.companyAddress,
                  companyName: body.companyName,
                  email: body.email,
                  firstName: body.firstName,
                  lastName: body.lastName,
                },
                userId
              );
            }
          } catch (e) {
            console.log("[UsersRouter] create-user", e);
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            throw new Error("Error Occured");
          }
        },
        {
          body: UpdateUserQueryBody,
          detail: {
            summary: "Update User Infos",
            description: `Create`,
            tags: [TAG.USERS],
          },
        }
      )
      .post(
        "/update-contact-infos",
        async ({ body, set, userId }) => {
          try {
            await updateUserContactInfos(
              {
                contactType: body.type as ContactType,
                contactValue: body.value,
              },
              userId
            );
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[usersRouter] update-contact-infos", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: UpdateUserContactInfosQueryBody,
          detail: {
            summary: "Update User Contact Infos",
            description: ` Update User Contact Infos. If the user does not exist, it will throw an error.`,
            tags: [TAG.USERS],
          },
        }
      )
      .get(
        "/byId",
        async ({ query, set, userId }) => {
          if (!query.id) throw new Error("ID is required");
          if (userId !== query.id) {
            const account = await findFirstAccountById(userId);
            if (
              !account ||
              (account.role !== "ADMIN" && account.role !== "GCA")
            ) {
              set.status = 400;
              return "Unauthorized";
            }
          }
          try {
            const user = await findFirstUserById(query.id);
            if (!user) {
              set.status = 404;
              return "user not found";
            }

            return user;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[UsersRouter] byId", e);
            throw new Error("Error Occured");
          }
        },
        {
          query: GetEntityByIdQueryParamsSchema,
          detail: {
            summary: "Get User by ID",
            description: `Get a User by ID. If the user does not exist, it will throw an error.`,
            tags: [TAG.USERS],
          },
        }
      )
      .get(
        "/gca-delegated-user",
        async ({ set, userId }) => {
          try {
            const gcaDelegatedUser = await findFirstDelegatedUserByUserId(
              userId
            );
            return gcaDelegatedUser;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[UsersRouter] gca-delegated-user", e);
            throw new Error("Error Occured");
          }
        },
        {
          detail: {
            summary: "Get GCA Delegated User",
            description: `Get GCA Delegated User. If the user does not exist, it will throw an error.`,
            tags: [TAG.USERS],
          },
        }
      )
      .get(
        "/user-stats",
        async ({ query, set, userId }) => {
          if (!query.id) throw new Error("ID is required");
          if (userId !== query.id) {
            const account = await findFirstAccountById(userId);
            if (
              !account ||
              (account.role !== "ADMIN" && account.role !== "GCA")
            ) {
              set.status = 400;
              return "Unauthorized";
            }
          }
          try {
            const userFarmsCount = await getUserFarmsCount(query.id);
            const pendingApplicationsCount =
              await getUserPendingApplicationsCount(query.id);
            const walletRewards = await getWalletRewards(query.id);
            console.log("walletRewards", {
              walletRewards,
              userFarmsCount,
              pendingApplicationsCount,
            });
            return {
              userFarmsCount,
              pendingApplicationsCount,
              usdgRewards: walletRewards?.totalUSDGRewards || 0,
              glowRewards: walletRewards?.totalGlowRewards || 0,
            };
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[UsersRouter] byId", e);
            throw new Error("Error Occured");
          }
        },
        {
          query: GetEntityByIdQueryParamsSchema,
          detail: {
            summary: "Get User by ID",
            description: `Get a User by ID. If the user does not exist, it will throw an error.`,
            tags: [TAG.USERS],
          },
        }
      )
  );
