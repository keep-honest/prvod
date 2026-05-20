import { eq } from "drizzle-orm";
import { getDb } from "@/infrastructure/persistence/db";
import { webhookDeliveries } from "@/infrastructure/persistence/schema";
import { createLogger } from "@/lib/logger";
import type { IDeliveryRepository, DeliveryRecord } from "@/interfaces/IDeliveryRepository";

const logger = createLogger("DeliveryRepository");

function rowToRecord(row: typeof webhookDeliveries.$inferSelect): DeliveryRecord {
  return {
    deliveryId: row.deliveryId,
    eventType: row.eventType,
    installationId: row.installationId,
    repositoryId: row.repositoryId,
    status: row.status,
    reason: row.reason,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt,
  };
}

export class DeliveryRepository implements IDeliveryRepository {
  private db = getDb();

  async findByDeliveryId(deliveryId: string): Promise<DeliveryRecord | null> {
    logger.debug("Looking up delivery", { deliveryId });

    const [row] = await this.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.deliveryId, deliveryId))
      .limit(1);

    return row ? rowToRecord(row) : null;
  }

  async record(input: {
    deliveryId: string;
    eventType: string;
    installationId?: number;
    repositoryId?: number;
  }): Promise<boolean> {
    logger.debug("Recording webhook delivery", {
      deliveryId: input.deliveryId,
      eventType: input.eventType,
    });

    // Atomic idempotency: INSERT ... ON CONFLICT DO NOTHING + returning row count
    const rows = await this.db
      .insert(webhookDeliveries)
      .values({
        deliveryId: input.deliveryId,
        eventType: input.eventType,
        installationId: input.installationId ?? null,
        repositoryId: input.repositoryId ?? null,
        status: "received",
      })
      .onConflictDoNothing()
      .returning({ deliveryId: webhookDeliveries.deliveryId });
    return rows.length > 0;
  }

  async updateStatus(deliveryId: string, status: string, reason?: string): Promise<void> {
    logger.debug("Updating delivery status", { deliveryId, status, reason });
    const isTerminal = ["processed", "skipped", "failed"].includes(status);
    const processedAt = isTerminal ? new Date() : null;
    const result = await this.db
      .update(webhookDeliveries)
      .set({
        status,
        reason: reason ?? null,
        processedAt,
      })
      .where(eq(webhookDeliveries.deliveryId, deliveryId))
      .returning({ deliveryId: webhookDeliveries.deliveryId });
    if (result.length === 0) {
      logger.warn("updateStatus matched no rows — delivery record may not exist", { deliveryId, status });
    }
  }
}
