import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createLogger } from "@/lib/logger";
import type { IStorageService } from "@/interfaces/IStorageService";

export abstract class BaseS3StorageService implements IStorageService {
  private readonly logger;

  protected constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly prefix: string,
    loggerName: string,
  ) {
    this.logger = createLogger(loggerName);
  }

  private fullKey(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  async upload(key: string, data: Buffer, contentType: string): Promise<void> {
    const fullKey = this.fullKey(key);
    this.logger.info("Uploading object", {
      key: fullKey,
      contentType,
      sizeBytes: data.length,
    });

    const start = performance.now();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: fullKey,
        Body: data,
        ContentType: contentType,
      }),
    );
    const elapsedMs = Math.round(performance.now() - start);
    const throughputMBs =
      elapsedMs > 0 ? (data.length / 1024 / 1024 / (elapsedMs / 1000)).toFixed(1) : "N/A";

    this.logger.info("Upload complete", { key: fullKey, elapsedMs, throughputMBs });
  }

  async getSignedUrl(key: string, expirySeconds: number): Promise<string> {
    const fullKey = this.fullKey(key);
    this.logger.debug("Generating signed URL", { key: fullKey, expirySeconds });

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: fullKey,
    });

    const url = await getSignedUrl(this.client, command, {
      expiresIn: expirySeconds,
    });

    this.logger.debug("Signed URL generated", { key: fullKey });
    return url;
  }

  async delete(key: string): Promise<void> {
    const fullKey = this.fullKey(key);
    this.logger.info("Deleting object", { key: fullKey });

    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: fullKey,
      }),
    );

    this.logger.info("Object deleted", { key: fullKey });
  }
}
