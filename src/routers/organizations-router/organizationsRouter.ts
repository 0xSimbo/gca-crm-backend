import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { GetEntityByIdQueryParamsSchema } from "../../schemas/shared/getEntityByIdParamSchema";
import { findOrganizationById } from "../../db/queries/organizations/findOrganizationById";
import { bearer as bearerplugin } from "@elysiajs/bearer";
import { bearerGuard } from "../../guards/bearerGuard";
import { jwtHandler } from "../../handlers/jwtHandler";
import { findAllOwnedOrganizations } from "../../db/queries/organizations/findAllOwnedOrganizations";
import { findFirstAccountById } from "../../db/queries/accounts/findFirstAccountById";
import { findAllUserOrganizations } from "../../db/queries/organizations/findAllUserOrganizations";
import { createOrganization } from "../../db/mutations/organizations/createOrganization";
import { findFirstUserById } from "../../db/queries/users/findFirstUserById";
import { findAllOrganizationMembers } from "../../db/queries/organizations/findAllOrganizationMembers";
import { findAllOrganizationRoles } from "../../db/queries/organizations/findAllOrganizationRoles";
import { deleteOrganization } from "../../db/mutations/organizations/deleteOrganization";
import { createOrganizationMember } from "../../db/mutations/organizations/createOrganizationMember";
import { findOrganizationUserById } from "../../db/queries/organizations/findOrganizationUserById";
import { organizationInvitationAcceptedTypes } from "../../constants/typed-data/organization";
import { recoverAddressHandler } from "../../handlers/recoverAddressHandler";
import { acceptOrganizationInvitation } from "../../db/mutations/organizations/acceptOrganizationInvitation";
import { deleteOrganizationUser } from "../../db/mutations/organizations/deleteOrganizationUser";

export const organizationsRouter = new Elysia({ prefix: "/organizations" })
  .get(
    "/byId",
    async ({ query, set }) => {
      if (!query.id) throw new Error("ID is required");
      try {
        const organization = await findOrganizationById(query.id);
        if (!organization) {
          set.status = 404;
          throw new Error("Organization not found");
        }

        return organization;
      } catch (e) {
        console.log("[organizationsRouter] byId", e);
        throw new Error("Error Occured");
      }
    },
    {
      query: t.Object({
        id: t.String(),
      }),
      detail: {
        summary: "Get Organization by ID",
        description: `Get Organization by ID`,
        tags: [TAG.ORGANIZATIONS],
      },
    }
  )
  .get(
    "/organization-members",
    async ({ query, set }) => {
      if (!query.id) throw new Error("ID is required");
      try {
        const organization = await findOrganizationById(query.id);
        if (!organization) {
          set.status = 404;
          throw new Error("Organization not found");
        }
        const organizationMembers = await findAllOrganizationMembers(query.id);

        return organizationMembers;
      } catch (e) {
        console.log("[organizationsRouter] organization-members", e);
        throw new Error("Error Occured");
      }
    },
    {
      query: t.Object({
        id: t.String(),
      }),
      detail: {
        summary: "Get Organization Members by ID",
        description: `Get Organization Members by ID`,
        tags: [TAG.ORGANIZATIONS],
      },
    }
  )
  .get(
    "/organization-roles",
    async ({ query, set }) => {
      if (!query.id) throw new Error("ID is required");
      try {
        const organization = await findOrganizationById(query.id);
        if (!organization) {
          set.status = 404;
          throw new Error("Organization not found");
        }

        const organizationRoles = await findAllOrganizationRoles(query.id);

        return organizationRoles;
      } catch (e) {
        console.log("[organizationsRouter] organization-roles", e);
        throw new Error("Error Occured");
      }
    },
    {
      query: t.Object({
        id: t.String(),
      }),
      detail: {
        summary: "Get Organization Members by ID",
        description: `Get Organization Members by ID`,
        tags: [TAG.ORGANIZATIONS],
      },
    }
  )
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
        "/all-by-user-id",
        async ({ set, userId }) => {
          try {
            const account = await findFirstAccountById(userId);
            if (!account) {
              set.status = 400;

              return "Unauthorized";
            }

            const ownedOrganizations = await findAllOwnedOrganizations(userId);
            const memberOrganizations = await findAllUserOrganizations(userId);

            return {
              ownedOrganizations,
              memberOrganizations,
            };
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[organizationsRouter] /all-by-user-id", e);
            throw new Error("Error Occured");
          }
        },
        {
          detail: {
            summary: "Get Organizations by User ID",
            description: `Get Organizations by User ID`,
            tags: [TAG.ORGANIZATIONS],
          },
        }
      )
      .post(
        "/create",
        async ({ body, set, userId }) => {
          try {
            const user = await findFirstUserById(userId);
            if (!user) {
              set.status = 404;
              return "User not found";
            }

            const organizationId = await createOrganization({
              name: body.organizationName,
              ownerId: userId,
              createdAt: new Date(),
            });

            return organizationId;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[organizationsRouter] create", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            organizationName: t.String(),
          }),
          detail: {
            summary: "Create an Organization",
            description: `Create an Organization`,
            tags: [TAG.ORGANIZATIONS],
          },
        }
      )
      .post(
        "/invite-member",
        async ({ body, set, userId }) => {
          try {
            const user = await findFirstUserById(userId);
            if (!user) {
              set.status = 404;
              return "User not found";
            }

            if (body.userId === userId) {
              set.status = 400;
              return "You cannot invite yourself";
            }

            const organization = await findOrganizationById(
              body.organizationId
            );

            if (!organization) {
              set.status = 404;
              return "Organization not found";
            }

            if (organization.ownerId !== userId) {
              set.status = 401;
              return "Unauthorized";
            }

            const invitedMember = await findFirstUserById(body.userId);

            if (!invitedMember) {
              set.status = 404;
              return "Invited member not found";
            }

            await createOrganizationMember({
              organizationId: body.organizationId,
              userId: body.userId,
              roleId: body.roleId,
              invitedAt: new Date(),
            });
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[organizationsRouter] invite-member", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            userId: t.String({
              example: "0x2e2771032d119fe590FD65061Ad3B366C8e9B7b9",
              minLength: 42,
              maxLength: 42,
            }),
            organizationId: t.String(),
            roleId: t.String(),
          }),
          detail: {
            summary: "Invite a Member to an Organization",
            description: `Invite a Member to an Organization`,
            tags: [TAG.ORGANIZATIONS],
          },
        }
      )
      .post(
        "/accept-invite",
        async ({ body, set, userId }) => {
          try {
            const user = await findFirstUserById(userId);
            if (!user) {
              set.status = 404;
              return "User not found";
            }
            const organizationUser = await findOrganizationUserById(
              body.organizationUserId
            );

            if (!organizationUser) {
              set.status = 404;
              return "Invitation not found";
            }

            const approvedValues = {
              organizationId: organizationUser.organizationId,
              deadline: body.deadline,
              // nonce is fetched from user account. nonce is updated for every new next-auth session
            };

            const recoveredAddress = await recoverAddressHandler(
              organizationInvitationAcceptedTypes,
              approvedValues,
              body.signature,
              userId
            );

            if (recoveredAddress.toLowerCase() !== user.id.toLowerCase()) {
              set.status = 400;
              return "Invalid Signature";
            }

            await acceptOrganizationInvitation(
              body.signature,
              body.organizationUserId
            );
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[organizationsRouter] accept-invite", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            signature: t.String(),
            organizationUserId: t.String(),
            deadline: t.Number(),
          }),
          detail: {
            summary: "Accept an Organization Invitation",
            description: `Accept an Organization Invitation`,
            tags: [TAG.ORGANIZATIONS],
          },
        }
      )
      .post(
        "/leave-organization",
        async ({ body, set, userId }) => {
          try {
            const user = await findFirstUserById(userId);
            if (!user) {
              set.status = 404;
              return "User not found";
            }
            const organizationUser = await findOrganizationUserById(
              body.organizationUserId
            );

            if (!organizationUser) {
              set.status = 404;
              return "Invitation not found";
            }

            await deleteOrganizationUser(body.organizationUserId);
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[organizationsRouter] leave-organization", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            organizationUserId: t.String(),
          }),
          detail: {
            summary: "Reject an Organization Invitation",
            description: `Reject an Organization Invitation`,
            tags: [TAG.ORGANIZATIONS],
          },
        }
      )
      .get(
        "/delete",
        async ({ query, set, userId }) => {
          try {
            console.log({ query });
            if (!query.id) throw new Error("ID is required");
            const user = await findFirstUserById(userId);
            if (!user) {
              set.status = 404;
              return "User not found";
            }

            const organization = await findOrganizationById(query.id);

            if (!organization) {
              set.status = 404;
              return "Organization not found";
            }
            console.log({ ownerId: organization.ownerId, userId });
            if (organization.ownerId !== userId) {
              set.status = 401;
              return "Unauthorized";
            }

            await deleteOrganization(query.id);
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[organizationsRouter] delete", e);
            throw new Error("Error Occured");
          }
        },
        {
          query: t.Object({
            id: t.String(),
          }),
          detail: {
            summary: "Delete an Organization",
            description: `Delete an Organization`,
            tags: [TAG.ORGANIZATIONS],
          },
        }
      )
  );
