export {
  HandoffError,
  buildStartPacket,
  enableHandoff,
  enableSync,
  getStatus,
  learn,
  normalizeProjectId,
  syncVault,
  writeCheckpoint,
} from "./core.js";

export type {
  CheckpointResult,
  EnableResult,
  LearnResult,
  Status,
} from "./core.js";
