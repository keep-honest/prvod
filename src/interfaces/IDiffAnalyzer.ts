import type { ChangeType } from "@/domain/entities/VideoScript";
import type { FileChangeSummary } from "@/domain/entities/FileChangeSummary";

export interface FileChange {
  filePath: string;
  linesAdded: number;
  linesRemoved: number;
  isNew: boolean;
  isDeleted: boolean;
  isRenamed: boolean;
  directory: string;
  importanceScore: number;
}

export interface DiffAnalysis {
  files: FileChange[];
  totalFilesChanged: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  suggestedChangeType: ChangeType;
  directoryGroups: Record<string, FileChange[]>;
  topFiles: FileChange[];
  topFileDiffs: Record<string, string>;
}

export interface IDiffAnalyzer {
  /** @deprecated Use analyzeCorpus() — operates on DiffMetadataCorpus files */
  analyze(diff: string): DiffAnalysis;
  /** Derive DiffAnalysis from pre-built FileChangeSummary array (spec 005). */
  analyzeCorpus(files: FileChangeSummary[]): DiffAnalysis;
}
