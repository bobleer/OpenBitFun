import { signal } from "nsh";
import type { SubmitUserMessageResult, TranscriptTurnView } from "./api";
import type { WorkspaceKey } from "./fleetTypes";
import { isWindowsPath } from "./shared/workspaceUtils";

export type PlanBuildStatus = "sending" | "queued" | "building" | "built" | "failed";
type PlanBuild = { sessionKey: string; turnId: string; status: PlanBuildStatus };
const builds = signal<Record<string, PlanBuild>>({});

export function planBuildKey(workspace: WorkspaceKey, path: string): string {
  const file = isWindowsPath(path) ? path.replace(/\\/g, "/").toLowerCase() : path;
  return JSON.stringify([workspace.deviceId, workspace.workspaceId, file]);
}

export function planBuildStatus(key: string): PlanBuildStatus | undefined {
  return builds()[key]?.status;
}

export function beginPlanBuild(key: string, sessionKey: string): string | null {
  const previous = builds()[key];
  if (previous && previous.status !== "failed") return null;
  const nonce = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  const turnId = `dialog_${Date.now()}_${nonce}`;
  builds.update(current => ({ ...current, [key]: { sessionKey, turnId, status: "sending" } }));
  return turnId;
}

export function acknowledgePlanBuild(key: string, turnId: string, outcome: SubmitUserMessageResult["outcome"] | null): void {
  const status = outcome === "started" ? "building" : outcome === "queued" ? "queued" : "failed";
  builds.update(current => {
    const entry = current[key];
    // An event or a transcript read can arrive before the command reply.
    if (entry?.turnId !== turnId || entry.status !== "sending") return current;
    return { ...current, [key]: { ...entry, status } };
  });
}

export function recordPlanBuildTurn(sessionKey: string, turnId: string, status: "building" | "built" | "failed"): void {
  builds.update(current => {
    const match = Object.entries(current).find(([, entry]) => entry.sessionKey === sessionKey && entry.turnId === turnId);
    if (!match || match[1].status === status || match[1].status === "built" || match[1].status === "failed") return current;
    return { ...current, [match[0]]: { ...match[1], status } };
  });
}

export function reconcilePlanBuildTurns(sessionKey: string, turns: readonly TranscriptTurnView[]): void {
  for (const entry of Object.values(builds())) {
    if (entry.sessionKey !== sessionKey || entry.status === "built" || entry.status === "failed") continue;
    const turn = turns.find(row => row.turnId === entry.turnId && row.settled);
    if (turn) recordPlanBuildTurn(sessionKey, entry.turnId, turn.status === "done" ? "built" : "failed");
  }
}
