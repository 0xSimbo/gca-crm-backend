import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { findOrganizationById } from "../../db/queries/organizations/findOrganizationById";
import { bearer as bearerplugin } from "@elysiajs/bearer";
import { bearerGuard } from "../../guards/bearerGuard";
import { jwtHandler } from "../../handlers/jwtHandler";
import { findFirstAccountById } from "../../db/queries/accounts/findFirstAccountById";
import { findAllUserOrganizations } from "../../db/queries/organizations/findAllUserOrganizations";
import { createOrganization } from "../../db/mutations/organizations/createOrganization";
import { findAllOrganizationMembers } from "../../db/queries/organizations/findAllOrganizationMembers";
import { findAllOrganizationRoles } from "../../db/queries/organizations/findAllOrganizationRoles";
import { deleteOrganization } from "../../db/mutations/organizations/deleteOrganization";
import { createOrganizationMember } from "../../db/mutations/organizations/createOrganizationMember";
import { findOrganizationUserById } from "../../db/queries/organizations/findOrganizationUserById";
import { organizationInvitationAcceptedTypes } from "../../constants/typed-data/organization";
import { recoverAddressHandler } from "../../handlers/recoverAddressHandler";
import { acceptOrganizationInvitation } from "../../db/mutations/organizations/acceptOrganizationInvitation";
import { deleteOrganizationUser } from "../../db/mutations/organizations/deleteOrganizationUser";
import { createOrganizationRole } from "../../db/mutations/organizations/createOrganizationRole";
import { findAllPermissions } from "../../db/queries/permissions/findAllPermissions";
import { deleteOrganizationRole } from "../../db/mutations/organizations/deleteOrganizationRole";
import { findOrganizationRoleById } from "../../db/queries/organizations/findOrganizationRoleById";
import { updateOrganizationRolePermissions } from "../../db/mutations/organizations/updateOrganizationRolePermissions";
import { findOrganizationMemberByUserId } from "../../db/queries/organizations/findOrganizationMemberByUserId";
import { updateOrganizationMemberDocumentsAccess } from "../../db/mutations/organizations/updateOrganizationMemberDocumentsAccess";
import { findAllOrganizationMembersWithDocumentsAccess } from "../../db/queries/organizations/findAllOrganizationMembersWithDocumentsAccess";
import { updateOrganizationMemberRole } from "../../db/mutations/organizations/updateOrganizationMemberRole";
import { findFirstUserById } from "../../db/queries/users/findFirstUserById";
import { createApplicationEncryptedMasterKeysForUsers } from "../../db/mutations/applications/createApplicationEncryptedMasterKeysForUsers";
import { deleteAllOrganizationMemberEncryptedApplicationsMasterKeys } from "../../db/mutations/organizations/deleteAllOrganizationMemberEncryptedApplicationsMasterKeys";

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
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
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
  .get(
    "/permissions",
    async ({ set }) => {
      try {
        const permissions = await findAllPermissions();

        return permissions;
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log("[organizationsRouter] permissions", e);
        throw new Error("Error Occured");
      }
    },
    {
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

            const userOrganizations = await findAllUserOrganizations(userId);

            return userOrganizations;
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
      .get(
        "/all-organization-members-with-documents-access",
        async ({ query, set, userId }) => {
          try {
            const user = await findFirstUserById(userId);
            if (!user) {
              set.status = 404;
              return "User not found";
            }

            const organization = await findOrganizationById(
              query.organizationId
            );

            if (!organization) {
              set.status = 404;
              return "Organization not found";
            }

            const organizationMembers =
              await findAllOrganizationMembersWithDocumentsAccess(
                query.organizationId
              );
            // Filter out the user from the list
            return organizationMembers.filter(
              (c) => c.userId.toUpperCase() !== userId.toLowerCase()
            );
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log(
              "[organizationsRouter] /all-organization-members-with-documents-access",
              e
            );
            throw new Error("Error Occured");
          }
        },
        {
          query: t.Object({
            organizationId: t.String(),
          }),
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

            const approvedValues = {
              organizationId: "create",
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

            const organizationId = await createOrganization(
              {
                name: body.organizationName,
                ownerId: userId,
                createdAt: new Date(),
              },
              body.signature
            );

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
            signature: t.String(),
            deadline: t.Number(),
          }),
          detail: {
            summary: "Create an Organization",
            description: `Create an Organization`,
            tags: [TAG.ORGANIZATIONS],
          },
        }
      )
      .post(
        "/create-organization-role",
        async ({ body, set, userId }) => {
          try {
            const user = await findFirstUserById(userId);
            if (!user) {
              set.status = 404;
              return "User not found";
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
            const roleId = await createOrganizationRole(
              { organizationId: body.organizationId, name: body.roleName },
              body.permissions.map((permission) => ({
                id: permission,
              }))
            );
            return roleId;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[organizationsRouter] create-organization-role", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            organizationId: t.String(),
            roleName: t.String(),
            permissions: t.Array(t.String()),
          }),
          detail: {
            summary: "Create an Organization Role",
            description: `Create an Organization Role`,
            tags: [TAG.ORGANIZATIONS],
          },
        }
      )
      .post(
        "/update-organization-role-permissions",
        async ({ body, set, userId }) => {
          try {
            const user = await findFirstUserById(userId);
            if (!user) {
              set.status = 404;
              return "User not found";
            }

            const role = await findOrganizationRoleById(body.roleId);

            if (!role) {
              set.status = 404;
              return "Role not found";
            }

            if (role.isReadOnly) {
              set.status = 400;
              return "Cannot update Admin role";
            }

            const organization = await findOrganizationById(
              role.organizationId
            );

            if (!organization) {
              set.status = 404;
              return "Organization not found";
            }

            if (organization.ownerId !== userId) {
              set.status = 401;
              return "Unauthorized";
            }

            const roleId = await updateOrganizationRolePermissions(
              body.roleId,
              body.permissions.map((permission) => ({
                id: permission,
              }))
            );
            return roleId;
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log(
              "[organizationsRouter] update-organization-role-permisions",
              e
            );
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            roleId: t.String(),
            permissions: t.Array(t.String()),
          }),
          detail: {
            summary: "Update an Organization Role Permissions",
            description: `Update an Organization Role Permissions`,
            tags: [TAG.ORGANIZATIONS],
          },
        }
      )
      .post(
        "/delete-organization-role",
        async ({ body, set, userId }) => {
          try {
            const user = await findFirstUserById(userId);
            if (!user) {
              set.status = 404;
              return "User not found";
            }

            const role = await findOrganizationRoleById(body.roleId);

            if (!role) {
              set.status = 404;
              return "Role not found";
            }

            if (role.isReadOnly) {
              set.status = 400;
              return "Cannot delete Admin role";
            }

            const organization = await findOrganizationById(
              role.organizationId
            );

            if (!organization) {
              set.status = 404;
              return "Organization not found";
            }

            if (organization.ownerId !== userId) {
              set.status = 401;
              return "Unauthorized";
            }
            await deleteOrganizationRole(body.roleId);
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[organizationsRouter] delete-organization-role", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            roleId: t.String(),
          }),
          detail: {
            summary: "Delete an Organization Role",
            description: `Delete an Organization Role`,
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

            const role = await findOrganizationRoleById(body.roleId);

            if (!role) {
              set.status = 404;
              return "Role not found";
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
        "/update-organization-member-role",
        async ({ body, set, userId }) => {
          try {
            const user = await findFirstUserById(userId);
            if (!user) {
              set.status = 404;
              return "User not found";
            }

            if (body.userId === userId) {
              set.status = 400;
              return "You cannot update your own role";
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
              return "Only the owner can update roles";
            }

            const organizationUser = await findOrganizationMemberByUserId(
              body.organizationId,
              body.userId
            );

            if (!organizationUser) {
              set.status = 404;
              return "Organization Member not found";
            }

            const role = await findOrganizationRoleById(body.roleId);

            if (!role) {
              set.status = 404;
              return "Role not found";
            }

            await updateOrganizationMemberRole(
              organizationUser.id,
              body.roleId
            );
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log(
              "[organizationsRouter] update-organization-member-role",
              e
            );
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
        "/generate-documents-access",
        async ({ body, set, userId }) => {
          try {
            const user = await findFirstUserById(userId);
            if (!user) {
              set.status = 404;
              return "User not found";
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

            const organizationMember = await findOrganizationMemberByUserId(
              body.organizationId,
              body.userId
            );

            if (!organizationMember) {
              set.status = 404;
              return "Organization Member not found";
            }
            console.log("organizationMemberId", organizationMember.id);
            await updateOrganizationMemberDocumentsAccess(
              organizationMember.id,
              true
            );

            await createApplicationEncryptedMasterKeysForUsers(
              body.delegatedApplicationsEncryptedMasterKeys
            );
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[organizationsRouter] generate-documents-access", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            organizationId: t.String(),
            userId: t.String(),
            delegatedApplicationsEncryptedMasterKeys: t.Array(
              t.Object({
                userId: t.String(),
                encryptedMasterKey: t.String(),
                applicationId: t.String(),
                organizationUserId: t.String(),
              })
            ),
          }),
          detail: {
            summary: "Generate Documents Access",
            description: `Generate Documents Access, this will create encrypted documents master keys`,
            tags: [TAG.ORGANIZATIONS],
          },
        }
      )
      .post(
        "/revoke-documents-access",
        async ({ body, set, userId }) => {
          try {
            const user = await findFirstUserById(userId);
            if (!user) {
              set.status = 404;
              return "User not found";
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

            const organizationMember = await findOrganizationMemberByUserId(
              body.organizationId,
              body.userId
            );

            if (!organizationMember) {
              set.status = 404;
              return "Organization Member not found";
            }

            if (organizationMember.isOwner) {
              set.status = 400;
              return "Cannot revoke access of owner";
            }

            await updateOrganizationMemberDocumentsAccess(
              organizationMember.id,
              false
            );

            await deleteAllOrganizationMemberEncryptedApplicationsMasterKeys(
              organizationMember.id
            );
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[organizationsRouter] revoke-documents-access", e);
            throw new Error("Error Occured");
          }
        },
        {
          body: t.Object({
            organizationId: t.String(),
            userId: t.String(),
          }),
          detail: {
            summary: "Revoke Documents Access",
            description: `Revoke Documents Access, this will delete all the encrypted documents master keys`,
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
        "/delete-organization-member",
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

            if (organizationUser.isOwner) {
              set.status = 400;
              return "Cannot delete owner";
            }

            const organization = await findOrganizationById(
              organizationUser?.organizationId
            );

            if (!organization) {
              set.status = 404;
              return "Organization not found";
            }
            const isOwner = organization.ownerId === userId;

            if (organizationUser.userId !== userId && !isOwner) {
              set.status = 401;
              return "Unauthorized";
            }

            await deleteOrganizationUser(body.organizationUserId);
          } catch (e) {
            if (e instanceof Error) {
              set.status = 400;
              return e.message;
            }
            console.log("[organizationsRouter] delete-organization-member", e);
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
