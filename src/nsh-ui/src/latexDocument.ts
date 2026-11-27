import { entryDeviceId, fleetActive, invokeCommand, transportKind } from "./bridge";
import { fleetDeviceById } from "./fleetStore";
import { dirnameOfPath } from "./shared/workspaceUtils";

export type LatexEngine = "pdflatex" | "xelatex";
export type LatexPaneMode = "source" | "split" | "preview";

export interface LatexTabView {
  engine: LatexEngine;
  auto: boolean;
  mode: LatexPaneMode;
  root: string;
  rootDraft: string;
  divider: number;
  build: { base64: string; name: string; path: string; revision: number } | null;
  log: string;
  logOpen: boolean;
  error: string;
  lastAttempt?: { path: string; engine: LatexEngine; source: string };
}

export function latexRootHint(source: string): string {
  return /^%\s*!\s*TeX\s+root\s*=\s*(.+)$/im.exec(source)?.[1]?.trim() ?? "";
}

export function latexMainPath(sourcePath: string, hint: string, remote: boolean): string {
  if (!hint.trim()) return sourcePath;
  const normalize = (path: string) => remote ? path : path.replace(/\\/g, "/");
  const path = normalize(hint.trim());
  const drive = !remote && /^[a-z]:\//i.test(path);
  const directory = normalize(dirnameOfPath(sourcePath, remote));
  const combined = path.startsWith("/") || drive || !directory ? path : directory.replace(/\/$/, "") + "/" + path;
  const prefix = !remote && combined.startsWith("//") ? "//" :
    combined.startsWith("/") ? "/" : !remote ? /^[a-z]:\//i.exec(combined)?.[0] ?? "" : "";
  const segments: string[] = [];
  for (const part of combined.slice(prefix.length).split("/")) {
    if (!part || part === ".") continue;
    if (part !== "..") segments.push(part);
    else if (segments.length && segments.at(-1) !== "..") segments.pop();
    else if (!prefix) segments.push(part);
  }
  return prefix + segments.join("/");
}

export function latexPreviewSupported(deviceId: string | null | undefined): boolean {
  if (!fleetActive()) return true;
  if (!deviceId) return false;
  return (transportKind() === "native" && entryDeviceId() === deviceId) ||
    fleetDeviceById(deviceId)?.hostCapabilities?.includes("workspace_latex_preview_v1") === true;
}

export function compileWorkspaceLatex(workspaceId: string, deviceId: string | undefined, filePath: string, engine: LatexEngine) {
  return invokeCommand<{ pdfBase64: string; log: string }>("compile_workspace_latex", { workspaceId, filePath, engine },
    deviceId ? { target: deviceId } : undefined);
}
