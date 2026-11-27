import { readFileContent } from "./api";
import { invokeCommand } from "./bridge";
import type { WorkspaceKey } from "./fleetTypes";

// Each base64 slice represents 768 KiB, below the host's 3 MiB chunk limit.
const CHUNK_BASE64 = 1024 * 1024;
type UploadStatus = { transferId: string; totalBytes: number; nextOffset: number; completed: boolean };

export function isWorkspaceFileMissing(error: unknown): boolean {
  return /no such file|\bos error 2\b(?!\d)|\benoent\b|\b(?:file|path) (?:not found|does not exist)\b/i.test(String(error));
}

function bytesInBase64(base64: string) {
  return base64.length / 4 * 3 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function binaryFileHash(base64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  if (typeof crypto.createHash === "function") return crypto.createHash("sha256").update(bytes).digest("hex");
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export async function workspaceBinaryHash(workspace: WorkspaceKey, path: string, maxBytes: number): Promise<string> {
  const route = workspace.deviceId ? { target: workspace.deviceId } : undefined;
  try {
    const meta = await invokeCommand<{ size?: number; isDir?: boolean }>("get_file_metadata", {
      workspaceId: workspace.workspaceId, path,
    }, route);
    if (meta?.isDir) throw new Error("destination-is-directory");
    if (typeof meta?.size === "number" && meta.size > maxBytes) throw new Error("pdf-too-large");
    const encoded = await readFileContent(workspace.workspaceId, path, "base64", route);
    if (typeof encoded !== "string" || bytesInBase64(encoded) > maxBytes) throw new Error("pdf-too-large");
    return await binaryFileHash(encoded);
  } catch (error) {
    if (isWorkspaceFileMissing(error)) return "";
    throw error;
  }
}

/** Checked binary upload to the workspace owner, independent of the controller's filesystem. */
export async function writeWorkspaceBinary(options: {
  workspace: WorkspaceKey;
  path: string;
  base64: string;
  sha256: string;
  expectedHash: string;
  assertCurrent: () => void;
}): Promise<void> {
  const { workspace, path, base64 } = options;
  const transferId = hex(crypto.getRandomValues(new Uint8Array(32)));
  const totalBytes = bytesInBase64(base64);
  const identity = { transferId, path, workspaceId: workspace.workspaceId };
  const route = workspace.deviceId ? { target: workspace.deviceId } : undefined;
  const call = async (request: Record<string, unknown>) => {
    options.assertCurrent();
    const status = await invokeCommand<UploadStatus>("workspace_file_upload", { ...identity, ...request }, route);
    options.assertCurrent();
    if (status?.transferId !== transferId || status.totalBytes !== totalBytes ||
        !Number.isSafeInteger(status.nextOffset) || status.nextOffset < 0 || status.nextOffset > totalBytes ||
        typeof status.completed !== "boolean") throw new Error("Invalid upload cursor from the workspace");
    return status;
  };
  try {
    let status = await call({ action: "begin", totalBytes, sha256: options.sha256, expectedHash: options.expectedHash });
    while (!status.completed && status.nextOffset < totalBytes) {
      const offset = status.nextOffset;
      const index = offset / 3 * 4;
      if (!Number.isSafeInteger(index)) throw new Error("Invalid binary upload boundary");
      try {
        status = await call({ action: "append", offset, contentBase64: base64.slice(index, index + CHUNK_BASE64) });
      } catch (error) {
        status = await call({ action: "status" });
        if (status.nextOffset === offset) throw error;
      }
      if (status.nextOffset <= offset) throw new Error("Workspace upload made no progress");
    }
    if (!status.completed) {
      try { status = await call({ action: "finish" }); }
      catch (error) {
        if (String(error).includes("FILE_CONFLICT")) throw error;
        status = await call({ action: "status" });
        if (!status.completed) throw error;
      }
    }
    if (!status.completed || status.nextOffset !== totalBytes) throw new Error("Workspace upload is incomplete");
  } catch (error) {
    void invokeCommand("workspace_file_upload", { ...identity, action: "cancel" }, route).catch(() => undefined);
    throw error;
  }
}
