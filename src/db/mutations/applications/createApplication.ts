import { ApplicationEncryptedMasterKeysType } from "../../../routers/applications-router/applicationsRouter";
import {
  ApplicationSteps,
  RequiredDocumentsNamesEnum,
} from "../../../types/api-types/Application";
import { db } from "../../db";
import { findGcasByIds } from "../../queries/gcas/findGcasByIds";
import { findUsersByIds } from "../../queries/users/findUsersByIds";
import {
  ApplicationInsertType,
  ApplicationsEncryptedMasterKeys,
  Documents,
  DocumentsInsertType,
  OrganizationApplications,
  applications,
} from "../../schema";

export const createApplication = async (
  organizationUsers: { id: string; organizationId: string }[],
  latestUtilityBillPublicUrl: string,
  applicationEncryptedMasterKeys: ApplicationEncryptedMasterKeysType[],
  application: ApplicationInsertType
) => {
  const ids = applicationEncryptedMasterKeys.map((key) => key.userId);
  const gcas = await findGcasByIds(ids);
  if (!gcas.length) {
    throw new Error("No gcas found");
  }

  const users = await findUsersByIds(ids);
  if (!users.length) {
    throw new Error("No users found");
  }

  const usersAndGcasLength = users.length + gcas.length;
  if (usersAndGcasLength !== ids.length) {
    throw new Error("Not all users and gcas found");
  }

  const usersWithEncryptedMasterKey = users.reduce(
    (
      acc: {
        userId: string;
        gcaDelegatedUserId: string | null;
        encryptedMasterKey: string;
        organizationUserId: string | undefined;
      }[],
      user
    ) => {
      const userEncryptedMasterKey = applicationEncryptedMasterKeys.find(
        (key) => key.userId === user.id
      );
      if (!userEncryptedMasterKey) {
        return acc;
      }
      acc.push({
        userId: user.id,
        gcaDelegatedUserId: user.gcaDelegatedUser?.id,
        encryptedMasterKey: userEncryptedMasterKey.encryptedMasterKey,
        organizationUserId: userEncryptedMasterKey.organizationUserId,
      });
      return acc;
    },
    []
  );

  const gcasWithEncryptedMasterKey = gcas.reduce(
    (
      acc: {
        userId: string;
        encryptedMasterKey: string;
      }[],
      gca
    ) => {
      const gcaEncryptedMasterKey = applicationEncryptedMasterKeys.find(
        (key) => key.userId === gca.id
      );
      if (!gcaEncryptedMasterKey) {
        return acc;
      }
      acc.push({
        userId: gca.id,
        encryptedMasterKey: gcaEncryptedMasterKey.encryptedMasterKey,
      });
      return acc;
    },
    []
  );

  if (
    usersWithEncryptedMasterKey.length + gcasWithEncryptedMasterKey.length !==
    ids.length
  ) {
    throw new Error("Not all users and gcas have encrypted master key");
  }

  return await db.transaction(async (tx) => {
    const res = await db
      .insert(applications)
      .values(application)
      .returning({ insertedId: applications.id });

    if (res.length === 0) {
      tx.rollback();
    }

    const resInsertedId = res[0].insertedId;

    const documents: DocumentsInsertType[] = [
      {
        name: RequiredDocumentsNamesEnum.latestUtilityBill,
        applicationId: resInsertedId,
        url: latestUtilityBillPublicUrl,
        type: "enc",
        annotation: null,
        isEncrypted: true,
        step: ApplicationSteps.enquiry,
        encryptedMasterKeys: [],
        createdAt: new Date(),
      },
    ];

    const documentInsert = await tx
      .insert(Documents)
      .values(documents)
      .returning({ id: Documents.id });

    if (documentInsert.length !== documents.length) {
      tx.rollback();
    }

    const usersApplicationEncryptedMasterKeysInsert = await tx
      .insert(ApplicationsEncryptedMasterKeys)
      .values(
        usersWithEncryptedMasterKey.map((u) => ({
          ...u,
          applicationId: resInsertedId,
        }))
      )
      .returning({ id: ApplicationsEncryptedMasterKeys.id });

    if (
      usersApplicationEncryptedMasterKeysInsert.length !==
      usersWithEncryptedMasterKey.length
    ) {
      tx.rollback();
    }

    const gcasApplicationEncryptedMasterKeysInsert = await tx
      .insert(ApplicationsEncryptedMasterKeys)
      .values(
        gcasWithEncryptedMasterKey.map((g) => ({
          ...g,
          applicationId: resInsertedId,
        }))
      )
      .returning({ id: ApplicationsEncryptedMasterKeys.id });

    if (
      gcasApplicationEncryptedMasterKeysInsert.length !==
      gcasWithEncryptedMasterKey.length
    ) {
      tx.rollback();
    }

    if (organizationUsers.length) {
      const OrganizationApplicationsRes = await tx
        .insert(OrganizationApplications)
        .values(
          organizationUsers.map(({ organizationId, id }) => ({
            organizationId,
            applicationId: resInsertedId,
            orgUserId: id,
          }))
        )
        .returning({ insertedId: OrganizationApplications.id });

      if (OrganizationApplicationsRes.length === 0) {
        tx.rollback();
      }
    }
  });
};
