import { S3Client } from "@aws-sdk/client-s3";
import { BaseS3StorageService } from "./BaseS3StorageService";

export class S3StorageService extends BaseS3StorageService {
  constructor() {
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const region = process.env.AWS_REGION;
    const bucket = process.env.AWS_S3_BUCKET_NAME;
    const endpoint = process.env.AWS_S3_ENDPOINT;

    if (!accessKeyId || !secretAccessKey || !region || !bucket) {
      throw new Error(
        "Missing S3 configuration. Required: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, AWS_S3_BUCKET_NAME",
      );
    }

    const prefix = (process.env.AWS_S3_PATH ?? "").replace(/^\/+|\/+$/g, "");
    const client = new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    });

    super(client, bucket, prefix, "S3StorageService");
  }
}
