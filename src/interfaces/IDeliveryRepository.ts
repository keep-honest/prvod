export interface DeliveryRecord {
  deliveryId: string;
  eventType: string;
  installationId: number | null;
  repositoryId: number | null;
  status: string;
  reason: string | null;
  receivedAt: Date;
  processedAt: Date | null;
}

export interface IDeliveryRepository {
  /** Returns the existing record if this delivery has already been processed. */
  findByDeliveryId(deliveryId: string): Promise<DeliveryRecord | null>;

  /**
   * Record a new delivery atomically.
   * Returns true if inserted, false if this deliveryId already existed.
   */
  record(input: {
    deliveryId: string;
    eventType: string;
    installationId?: number;
    repositoryId?: number;
  }): Promise<boolean>;

  updateStatus(deliveryId: string, status: string, reason?: string): Promise<void>;
}
