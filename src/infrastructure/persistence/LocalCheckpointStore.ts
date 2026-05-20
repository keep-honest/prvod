import path from "node:path";
import fs from "node:fs/promises";
import { createLogger } from "@/lib/logger";
import type {
  IPipelineCheckpointStore,
  PipelineCheckpoint,
} from "@/interfaces/IPipelineCheckpoint";

const logger = createLogger("LocalCheckpointStore");

export class LocalCheckpointStore implements IPipelineCheckpointStore {
  private baseDir: string;

  constructor() {
    this.baseDir = process.env.LOCAL_STORAGE_DIR ?? ".local-storage";
    logger.info("LocalCheckpointStore initialized", { baseDir: this.baseDir });
  }

  private checkpointPath(jobId: string): string {
    return path.join(this.baseDir, "cache", jobId, "checkpoint.json");
  }

  async save(checkpoint: PipelineCheckpoint): Promise<void> {
    const filePath = this.checkpointPath(checkpoint.jobId);
    logger.info("Saving checkpoint", {
      jobId: checkpoint.jobId,
      completedStep: checkpoint.completedStep,
      filePath,
    });

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(checkpoint, null, 2));
    logger.debug("Checkpoint saved", { jobId: checkpoint.jobId });
  }

  async load(jobId: string): Promise<PipelineCheckpoint | null> {
    const filePath = this.checkpointPath(jobId);
    logger.debug("Loading checkpoint", { jobId, filePath });

    try {
      const data = await fs.readFile(filePath, "utf-8");
      const checkpoint = JSON.parse(data) as PipelineCheckpoint;
      logger.info("Checkpoint loaded", {
        jobId,
        completedStep: checkpoint.completedStep,
      });
      return checkpoint;
    } catch {
      logger.debug("No checkpoint found", { jobId });
      return null;
    }
  }

  async delete(jobId: string): Promise<void> {
    const filePath = this.checkpointPath(jobId);
    logger.debug("Deleting checkpoint", { jobId });

    await fs.unlink(filePath).catch(() => {
      logger.debug("Checkpoint file not found for deletion", { jobId });
    });
  }
}
