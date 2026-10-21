/** Native iOS archive operations. These are separate from portable profile import/export. */
export interface IosBackupStatus {
  status: "idle" | "preparing" | "ready" | "failed";
  filename?: string;
  bytes?: number;
  downloadUrl?: string;
  createdAt?: string;
  error?: string;
}

export interface IosRestoreStatus {
  status: "idle" | "staged" | "applying" | "applied" | "rolled-back" | "failed";
  restartRequired: boolean;
  createdAt?: string;
  message?: string;
  files?: number;
  bytes?: number;
}
