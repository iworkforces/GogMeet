export function expectedWindowsArtifacts(version: string): string[];

export function verifyWindowsReleaseInventory(opts?: {
  distDir?: string;
  requireUpdaterYml?: boolean;
  requireWinSign?: boolean;
  verifySignature?: (path: string) => { ok: boolean; message: string };
  files?: string[];
}): {
  ok: boolean;
  version: string;
  expected: string[];
  missing: string[];
  message: string;
};
