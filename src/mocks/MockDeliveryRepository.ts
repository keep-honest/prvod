import type { IDeliveryRepository, DeliveryRecord } from "@/interfaces/IDeliveryRepository";

export class MockDeliveryRepository implements IDeliveryRepository {
  private deliveries: DeliveryRecord[] = [];

  async findByDeliveryId(deliveryId: string): Promise<DeliveryRecord | null> {
    return this.deliveries.find((d) => d.deliveryId === deliveryId) ?? null;
  }

  async record(input: {
    deliveryId: string;
    eventType: string;
    installationId?: number;
    repositoryId?: number;
  }): Promise<boolean> {
    if (this.deliveries.some((d) => d.deliveryId === input.deliveryId)) return false;
    this.deliveries.push({
      deliveryId: input.deliveryId,
      eventType: input.eventType,
      installationId: input.installationId ?? null,
      repositoryId: input.repositoryId ?? null,
      status: "received",
      reason: null,
      receivedAt: new Date(),
      processedAt: null,
    });
    return true;
  }

  async updateStatus(deliveryId: string, status: string, reason?: string): Promise<void> {
    const d = this.deliveries.find((d) => d.deliveryId === deliveryId);
    if (d) {
      d.status = status;
      d.reason = reason ?? null;
      if (["processed", "skipped", "failed"].includes(status)) {
        d.processedAt = new Date();
      } else {
        d.processedAt = null;
      }
    }
  }

  /** Test helper */
  reset(): void {
    this.deliveries = [];
  }
}
