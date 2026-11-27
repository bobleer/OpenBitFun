import { readFileContent } from "./api";
import { changedOnDisk, dirtyPaths, fileSaving, LARGE_FILE_BYTES, openFile } from "./fileStore";
import type { WorkspaceKey } from "./fleetTypes";
import { currentLocale, localizeHostError, tr } from "./i18n";
import { acknowledgePlanBuild, beginPlanBuild, planBuildKey, planBuildStatus } from "./planBuildStore";
import { readPlanDocument } from "./planDocument";
import { secondaryPendingTurnState, secondaryRunningTurnId, sendSecondaryTurn } from "./splitSessionStore";
import {
  activeSession, activeSessionDevice, activeSessionKey, activeWorkspaceKey, pendingTurnState, runningTurnId, sendTurn,
  secondarySessionDevice, secondarySessionKey, secondaryWorkspaceId,
} from "./state";
import { pushToast } from "./ui/overlays";

export function currentPlanBuild(path: string, workspace = activeWorkspaceKey()) {
  return workspace ? planBuildStatus(planBuildKey(workspace, path)) : undefined;
}

function buildWorkspace(pane: 0 | 1): WorkspaceKey | null {
  if (pane === 1) {
    const workspaceId = secondaryWorkspaceId();
    return workspaceId ? { workspaceId, deviceId: secondarySessionDevice() } : null;
  }
  const workspace = activeWorkspaceKey();
  return workspace && activeSessionDevice() === workspace.deviceId && activeSession()?.workspaceId === workspace.workspaceId
    ? workspace : null;
}

export function planBuildBlocked(path: string, pane: 0 | 1 = 0): string | undefined {
  const workspace = buildWorkspace(pane);
  const sessionKey = pane === 1 ? secondarySessionKey() : activeSessionKey();
  if (!workspace || !sessionKey) return tr("plan.buildNeedsSession");
  const current = activeWorkspaceKey();
  if (current?.workspaceId === workspace.workspaceId && current.deviceId === workspace.deviceId) {
    const key = planBuildKey(workspace, path);
    const matches = (other: string) => planBuildKey(workspace, other) === key;
    if (fileSaving() || dirtyPaths().some(matches) || Object.keys(changedOnDisk()).some(matches)) return tr("plan.saveBeforeBuild");
  }
  const busy = pane === 1 ? secondaryRunningTurnId() || secondaryPendingTurnState() : runningTurnId() || pendingTurnState();
  if (busy) return tr("plan.buildBusy");
}

export async function buildOpenPlan(path: string): Promise<void> {
  const file = openFile();
  if (file?.path !== path || file.large) return;
  await buildSavedPlan(path, file.content);
}

export async function readPlanText(workspace: WorkspaceKey, path: string): Promise<string> {
  return readFileContent(workspace.workspaceId, path, undefined, workspace.deviceId ? { target: workspace.deviceId } : undefined);
}

/** The open document also supplies the disk version the user reviewed. */
export async function buildSavedPlan(path: string, expectedSaved?: string, pane: 0 | 1 = 0): Promise<void> {
  const selectedSession = pane === 1 ? secondarySessionKey : activeSessionKey;
  const workspace = buildWorkspace(pane);
  const sessionKey = selectedSession();
  if (!workspace || !sessionKey || planBuildBlocked(path, pane)) return;
  const key = planBuildKey(workspace, path);
  const turnId = beginPlanBuild(key, sessionKey);
  if (!turnId) return;
  try {
    const saved = await readPlanText(workspace, path);
    const current = buildWorkspace(pane);
    if (selectedSession() !== sessionKey || current?.workspaceId !== workspace.workspaceId ||
      current?.deviceId !== workspace.deviceId || planBuildBlocked(path, pane)) {
      acknowledgePlanBuild(key, turnId, null);
      return;
    }
    if (expectedSaved !== undefined && (saved !== expectedSaved || openFile()?.path !== path || saved !== openFile()?.content)) {
      pushToast(tr("plan.diskChanged"), "warning");
      acknowledgePlanBuild(key, turnId, null);
      return;
    }
    if (typeof saved !== "string" || saved.length > LARGE_FILE_BYTES || readPlanDocument(saved).kind !== "plan") {
      pushToast(tr("plan.invalidMetadata"), "warning");
      acknowledgePlanBuild(key, turnId, null);
      return;
    }
    const prompt = `Implement the plan at ${JSON.stringify(path)}.\n\n` +
      "Read the plan file before making changes and treat it as the source of truth. " +
      "Implement the plan and verify the result. Do not edit the plan file unless the user requests a plan revision.\n\n" +
      `Use the UI language (${currentLocale()}) for all user-facing communication unless the user requests another language.`;
    const options = { turnId, attachments: [], references: [] };
    const outcome = pane === 1 ? await sendSecondaryTurn(prompt, "queue", options)
      : await sendTurn(prompt, "queue", { ...options, files: [] });
    acknowledgePlanBuild(key, turnId, outcome);
  } catch (error) {
    acknowledgePlanBuild(key, turnId, null);
    const message = error instanceof Error ? error.message : String(error);
    pushToast(localizeHostError(message), "error");
  }
}
