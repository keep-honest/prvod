import { S3Client } from "@aws-sdk/client-s3";
import { BaseS3StorageService } from "./BaseS3StorageService";

export class R2StorageService extends BaseS3StorageService {
  constructor() {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucket = process.env.R2_BUCKET_NAME;

    if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
      throw new Error(
        "Missing R2 configuration. Required: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME",
      );
    }

    const prefix = (process.env.R2_PATH ?? "").replace(/^\/+|\/+$/g, "");
    const client = new S3Client({
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      region: "auto",
      credentials: { accessKeyId, secretAccessKey },
    });

    super(client, bucket, prefix, "R2StorageService");
  }
}
