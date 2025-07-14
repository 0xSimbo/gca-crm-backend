import { S3 } from "@aws-sdk/client-s3";

const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
  throw new Error(
    "AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be provided"
  );
}
if (!CLOUDFLARE_ACCOUNT_ID) {
  throw new Error("CLOUDFLARE_ACCOUNT_ID must be provided");
}

const s3 = new S3({
  region: "auto",
  endpoint: `https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: `${AWS_ACCESS_KEY_ID}`,
    secretAccessKey: `${AWS_SECRET_ACCESS_KEY}`,
  },
});

export async function listObjects(bucketName: string, prefix?: string) {
  try {
    const response = await s3.listObjectsV2({
      Bucket: bucketName,
      Prefix: prefix,
    });

    return response.Contents;
  } catch (error) {
    console.error(
      `Error listing objects in ${bucketName} with prefix ${prefix}:`,
      error
    );
    throw error;
  }
}

export async function createAndUploadTXTFile(
  bucketName: string,
  key: string,
  textContent: string
) {
  try {
    const buffer = Buffer.from(textContent, "utf-8");
    const params = {
      Bucket: bucketName,
      Key: key,
      Body: buffer,
      ContentType: "text/plain",
    };

    const response = await s3.putObject(params);

    if (response.$metadata.httpStatusCode === 200) {
      // console.log("File uploaded successfully:", key);
      return `https://pub-65d7379333b140c5a7e4d6e74d173542.r2.dev/${key}`;
    }
    throw new Error("Error uploading file");
  } catch (error) {
    console.error(`Error creating or uploading ${key}:`, error);
    throw error;
  }
}

export async function createAndUploadJsonFile(
  bucketName: string,
  key: string,
  data: any
) {
  try {
    const params = {
      Bucket: bucketName,
      Key: key,
      Body: JSON.stringify(data),
      ContentType: "application/json",
    };
    const response = await s3.putObject(params);
    if (response.$metadata.httpStatusCode === 200) {
      // console.log("File uploaded successfully:", key);
      return `https://pub-65d7379333b140c5a7e4d6e74d173542.r2.dev/${key}`;
    }
    throw new Error("Error uploading file");
  } catch (error) {
    console.log(`Error uploading ${key} to R2`, error);
    throw error;
  }
}

export async function downloadFile(
  bucketName: string,
  key: string
): Promise<Buffer> {
  try {
    const response = await s3.getObject({
      Bucket: bucketName,
      Key: key,
    });

    if (!response.Body) {
      throw new Error("No body in response");
    }

    // Convert the stream to a buffer
    const chunks: any[] = [];
    for await (const chunk of response.Body as any) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    console.error(`Error downloading ${key} from ${bucketName}:`, error);
    throw error;
  }
}

export async function uploadFile(
  bucketName: string,
  key: string,
  body: Buffer,
  contentType: string
) {
  try {
    const params = {
      Bucket: bucketName,
      Key: key,
      Body: body,
      ContentType: contentType,
    };

    const response = await s3.putObject(params);

    if (response.$metadata.httpStatusCode === 200) {
      // Return the public URL based on the bucket
      const isPublicBucket =
        bucketName === process.env.R2_NOT_ENCRYPTED_FILES_BUCKET_NAME;
      return isPublicBucket
        ? `https://pub-${process.env.R2_PUB_NOT_ENCRYPTED_BUCKET_ID}.r2.dev/${key}`
        : `https://pub-65d7379333b140c5a7e4d6e74d173542.r2.dev/${key}`;
    }
    throw new Error("Error uploading file");
  } catch (error) {
    console.error(`Error uploading ${key}:`, error);
    throw error;
  }
}
