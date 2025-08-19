import { Elysia, t } from "elysia";
import { TAG } from "../../constants";
import { findFirstUserById } from "../../db/queries/users/findFirstUserById";
import { findOrganizationById } from "../../db/queries/organizations/findOrganizationById";
import { findOrganizationMemberByUserId } from "../../db/queries/organizations/findOrganizationMemberByUserId";
import { PermissionsEnum } from "../../types/api-types/Permissions";
import { findAllApplicationsByOrganizationId } from "../../db/queries/applications/findAllApplicationsByOrganizationId";
import { createOrganizationApplication } from "../../db/mutations/organizations/createOrganizationApplication";
import { FindFirstApplicationById } from "../../db/queries/applications/findFirstApplicationById";
import { deleteOrganizationApplication } from "../../db/mutations/organizations/deleteOrganizationApplication";
import { db } from "../../db/db";
import { OrganizationUsers } from "../../db/schema";
import { eq } from "drizzle-orm";
import { findFirstOrgMemberwithShareAllApplications } from "../../db/queries/organizations/findFirstOrgMemberwithShareAllApplications";
import { findAllApplicationsOwnersByIds } from "../../db/queries/applications/findAllApplicationsOwnersByIds";
import { createOrganizationApplicationBatch } from "../../db/mutations/organizations/createOrganizationApplicationBatch";
import { findAllApplicationsByOrgUserId } from "../../db/queries/applications/findAllApplicationsByOrgUserId";
import { deleteOrganizationApplicationBatch } from "../../db/mutations/organizations/deleteOrganizationApplicationBatch";

export const organizationApplicationRoutes = new Elysia()
  .get(
    "/all-applications-by-organization-id",
    async (ctx) => {
      const { query, set } = ctx as any;
      const userId = (ctx as any).userId as string;
      if (!query.organizationId) throw new Error("organizationId is required");
      try {
        const user = await findFirstUserById(userId);
        if (!user) {
          set.status = 400;
          return "Unauthorized";
        }

        const organization = await findOrganizationById(query.organizationId);

        const isOrganizationOwner = organization?.ownerId === userId;

        const organizationMember = await findOrganizationMemberByUserId(
          query.organizationId,
          userId
        );

        const isAuthorized =
          isOrganizationOwner ||
          organizationMember?.role.rolePermissions.find(
            (p) =>
              p.permission.key === PermissionsEnum.ApplicationsRead ||
              p.permission.key === PermissionsEnum.ProtocolFeePayment
          );

        const applications = await findAllApplicationsByOrganizationId(
          query.organizationId
        );

        if (!isAuthorized) {
          // return only applications owned by the user
          return applications.filter((c) => c.user.id === userId);
        }

        return applications;
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log(
          "[organizationsRouter] /all-applications-by-organization-id",
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
        summary: "Get all applications by organization ID",
        description: `Get all applications by organization ID and check if the user is authorized to view applications`,
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .post(
    "/add-application-to-organization",
    async (ctx) => {
      const { body, set } = ctx as any;
      const userId = (ctx as any).userId as string;
      try {
        const user = await findFirstUserById(userId);
        if (!user) {
          set.status = 400;
          return "Unauthorized";
        }

        const organizationMember = await findOrganizationMemberByUserId(
          body.organizationId,
          userId
        );

        if (!organizationMember) {
          set.status = 400;
          return "User is not a member of the organization";
        }

        const isAuthorized = organizationMember?.role.rolePermissions.find(
          (p) => p.permission.key === PermissionsEnum.ApplicationsShare
        );

        if (!isAuthorized) {
          set.status = 400;
          return "User does not have the required permissions";
        }

        const application = await FindFirstApplicationById(body.applicationId);

        if (!application) {
          set.status = 404;
          return "Application not found";
        }

        if (application.userId !== userId) {
          set.status = 400;
          return "User is not the owner of the application";
        }

        if (
          application.organizationApplication?.organizationId ===
          body.organizationId
        ) {
          set.status = 400;
          return "Application already added to organization";
        }

        await createOrganizationApplication(
          organizationMember.id,
          body.organizationId,
          body.applicationId,
          body.delegatedApplicationsEncryptedMasterKeys
        );
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log(
          "[organizationsRouter] /add-application-to-organization",
          e
        );
        throw new Error("Error Occured");
      }
    },
    {
      body: t.Object({
        organizationId: t.String(),
        applicationId: t.String(),
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
        summary: "Add application to organization",
        description: `Add application to organization and check if the user is authorized to add applications to the organization`,
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .post(
    "/share-all-applications-to-organization",
    async (ctx) => {
      const { body, set } = ctx as any;
      const userId = (ctx as any).userId as string;
      try {
        const user = await findFirstUserById(userId);
        if (!user) {
          set.status = 400;
          return "Unauthorized";
        }

        const organizationMember = await findOrganizationMemberByUserId(
          body.organizationId,
          userId
        );

        if (!organizationMember) {
          set.status = 400;
          return "User is not a member of the organization";
        }

        const isAlreadyShardingAllApplications =
          await findFirstOrgMemberwithShareAllApplications(userId);

        if (isAlreadyShardingAllApplications) {
          set.status = 400;
          return "User is already sharing all applications with an organization";
        }

        const isAuthorized = organizationMember?.role.rolePermissions.find(
          (p) => p.permission.key === PermissionsEnum.ApplicationsShare
        );

        if (!isAuthorized) {
          set.status = 400;
          return "User does not have the required permissions";
        }

        const applications = await findAllApplicationsOwnersByIds(
          body.applicationIds
        );

        if (applications.length !== body.applicationIds.length) {
          set.status = 404;
          return "Application not found";
        }

        if (applications.some((a) => a.user.id !== userId)) {
          set.status = 400;
          return "User is not the owner of the application";
        }

        if (body.applicationIds.length === 0) {
          await db
            .update(OrganizationUsers)
            .set({
              shareAllApplications: true,
            })
            .where(eq(OrganizationUsers.id, organizationMember.id));
        } else {
          await createOrganizationApplicationBatch(
            organizationMember.id,
            body.organizationId,
            body.applicationIds,
            body.delegatedApplicationsEncryptedMasterKeys
          );
        }
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log(
          "[organizationsRouter] /share-all-applications-to-organization",
          e
        );
        throw new Error("Error Occured");
      }
    },
    {
      body: t.Object({
        organizationId: t.String(),
        applicationIds: t.Array(t.String()),
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
        summary: "Share all org member applications with the organization",
        description: `share all org member applications with the organization`,
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .post(
    "/remove-application-to-organization",
    async (ctx) => {
      const { body, set } = ctx as any;
      const userId = (ctx as any).userId as string;
      try {
        const user = await findFirstUserById(userId);
        if (!user) {
          set.status = 400;
          return "Unauthorized";
        }

        const organization = await findOrganizationById(body.organizationId);

        const isOrganizationOwner = organization?.ownerId === userId;

        const organizationMember = await findOrganizationMemberByUserId(
          body.organizationId,
          userId
        );

        const application = await FindFirstApplicationById(body.applicationId);

        if (!application) {
          set.status = 404;
          return "Application not found";
        }

        const isAuthorized =
          isOrganizationOwner ||
          organizationMember?.role.rolePermissions.find(
            (p) => p.permission.key === PermissionsEnum.ApplicationsShare
          ) ||
          application?.userId === userId;

        if (!isAuthorized) {
          set.status = 400;
          return "Unauthorized";
        }

        if (application.userId !== userId) {
          set.status = 400;
          return "Unauthorized";
        }

        await deleteOrganizationApplication(
          body.organizationId,
          body.applicationId
        );
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log(
          "[organizationsRouter] /remove-organization-application",
          e
        );
        throw new Error("Error Occured");
      }
    },
    {
      body: t.Object({
        organizationId: t.String(),
        applicationId: t.String(),
      }),
      detail: {
        summary: "Remove application from organization",
        description: `Remove application from organization and check if the user is authorized to remove the application from the organization`,
        tags: [TAG.APPLICATIONS],
      },
    }
  )
  .post(
    "/remove-org-user-applications-from-organization",
    async (ctx) => {
      const { body, set } = ctx as any;
      const userId = (ctx as any).userId as string;
      try {
        const user = await findFirstUserById(userId);
        if (!user) {
          set.status = 400;
          return "Unauthorized";
        }

        const organizationMember = await findOrganizationMemberByUserId(
          body.organizationId,
          userId
        );

        if (!organizationMember) {
          set.status = 400;
          return "Unauthorized";
        }

        const allOrgUserApplications = await findAllApplicationsByOrgUserId(
          organizationMember.id
        );

        await deleteOrganizationApplicationBatch(
          organizationMember.id,
          body.organizationId,
          allOrgUserApplications.map((a) => a.id)
        );
      } catch (e) {
        if (e instanceof Error) {
          set.status = 400;
          return e.message;
        }
        console.log(
          "[organizationsRouter] /remove-org-user-applications-from-organization",
          e
        );
        throw new Error("Error Occured");
      }
    },
    {
      body: t.Object({
        organizationId: t.String(),
      }),
      detail: {
        summary: "Remove applications from organization",
        description: `Remove applications from organization and check if the user is authorized to remove applications from the organization`,
        tags: [TAG.APPLICATIONS],
      },
    }
  );

export type OrganizationApplicationRoutes =
  typeof organizationApplicationRoutes;
