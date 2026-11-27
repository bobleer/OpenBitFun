import { cleanup, computed, effect, openUrl, signal, Text, untracked, View } from "nsh";
import { createWorkspaceDirectory } from "../api";
import { invokeCommand } from "../bridge";
import { LARGE_FILE_BYTES, loadRoot, openFile } from "../fileStore";
import type { WorkspaceKey } from "../fleetTypes";
import { formatCount } from "../format";
import { localizeHostError, tr } from "../i18n";
import { buildSavedPlan, currentPlanBuild, planBuildBlocked, readPlanText } from "../planBuildActions";
import { planBuildKey } from "../planBuildStore";
import { readPlanDocument } from "../planDocument";
import type { TranscriptPlanArtifact } from "../planToolArtifact";
import { basenameOfPath, dirnameOfPath, isWindowsPath, joinWorkspacePath, resolveWorkspaceMarkdownLink } from "../shared/workspaceUtils";
import { activeWorkspaceKey, openInAuxPane } from "../state";
import { designControlColors, palette, space, textStyle } from "../theme";
import { Icon } from "./icons";
import { MarkdownPreview } from "./markdownEditor";
import { Spinner } from "./motion";
import { PlanBuildButton, PlanTodoRows } from "./PlanDocument";
import { Button, focusRingStyle, IconButton, InlineBanner } from "./primitives";
import { toolCardMetrics as metrics } from "./ToolCardFrame";
import type { ToolRunState } from "./toolCards";

export interface PlanArtifactOwner {
  workspace: WorkspaceKey;
  sessionKey: string;
  root: string;
  remote: boolean;
}

const inset = { paddingHorizontal: metrics.prominentPaddingInline, paddingVertical: metrics.prominentPaddingBlock };
const runtimeUri = (path: string) => path.startsWith("openbitfun://runtime/");

function artifactPath(path: string, owner: PlanArtifactOwner) {
  if (runtimeUri(path)) {
    const scope = path.slice("openbitfun://runtime/".length).split("/")[0];
    return scope === "current" || scope === owner.workspace.workspaceId ? path : "";
  }
  if (!path || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return "";
  if (path.startsWith("/") || (!owner.remote && isWindowsPath(path))) return path;
  return owner.root ? joinWorkspacePath(owner.root, path, owner.remote) : "";
}

function sameWorkspace(workspace: WorkspaceKey) {
  const active = activeWorkspaceKey();
  return active?.deviceId === workspace.deviceId && active?.workspaceId === workspace.workspaceId;
}

async function copyRuntimePlan(owner: PlanArtifactOwner, from: string, to: string): Promise<void> {
  const { workspace } = owner;
  const text = await readPlanText(workspace, from);
  if (typeof text !== "string" || text.length > LARGE_FILE_BYTES || readPlanDocument(text).kind !== "plan") {
    throw new Error(tr("plan.invalidMetadata"));
  }
  const route = workspace.deviceId ? { target: workspace.deviceId } : undefined;
  await createWorkspaceDirectory(workspace.workspaceId, dirnameOfPath(to, owner.remote), route);
  try {
    await invokeCommand("write_file_content", { workspaceId: workspace.workspaceId, filePath: to, content: text, expectedHash: "" }, route);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("FILE_CONFLICT")) throw error;
    if (await readPlanText(workspace, to).catch(() => null) !== text) throw new Error(tr("plan.projectExists"));
  }
  if (sameWorkspace(workspace)) void loadRoot();
}

function parsedPlan(text: string) {
  if (typeof text !== "string" || text.length > LARGE_FILE_BYTES) return null;
  const plan = readPlanDocument(text);
  return plan.kind === "plan" ? plan : null;
}

export function PlanArtifactCard(props: {
  artifact: TranscriptPlanArtifact;
  state: ToolRunState;
  pane: 0 | 1;
  owner: PlanArtifactOwner | null;
  activate: (owner: PlanArtifactOwner) => boolean;
}) {
  const expanded = signal(false);
  const refreshed = signal<{ key: string; plan: ReturnType<typeof parsedPlan> } | null>(null);
  const reading = signal(false);
  const copying = signal(false);
  const copied = signal(false);
  const notice = signal("");
  const path = computed(() => props.owner ? artifactPath(props.artifact.path, props.owner) : "");
  const key = computed(() => props.owner && path() ? planBuildKey(props.owner.workspace, path()) : "");
  const saved = () => props.state === "completed";
  const activeWrite = () => props.state === "running" || props.state === "confirmation";
  const plan = () => {
    const current = refreshed();
    return current?.key === key() && current.plan ? current.plan : props.artifact;
  };
  const remaining = () => plan().todos.filter(row => row.status !== "completed" && row.status !== "cancelled").length;
  const title = () => plan().name || basenameOfPath(props.artifact.path, props.owner?.remote) || tr("plan.generating");
  const status = () => currentPlanBuild(path(), props.owner?.workspace ?? null);
  const blocked = () => !saved() || !path() ? tr("plan.unavailable") : planBuildBlocked(path(), props.pane);
  const destination = () => {
    const owner = props.owner;
    if (!owner?.root || !path() || props.artifact.storage !== "runtime") return "";
    const basename = basenameOfPath(path(), owner.remote);
    const name = /\.plan\.md$/i.test(basename) ? basename : basename.replace(/\.md$/i, "") + ".plan.md";
    const target = joinWorkspacePath(owner.root, `.openbitfun/plans/${name}`, owner.remote);
    return planBuildKey(owner.workspace, target) !== key() ? target : "";
  };
  let generation = 0;
  cleanup(() => { generation += 1; });

  async function refresh(): Promise<void> {
    const owner = props.owner;
    const filePath = path();
    const identity = key();
    if (!owner || !filePath || !saved() || reading()) return;
    const request = ++generation;
    reading.set(true);
    notice.set("");
    try {
      const plan = parsedPlan(await readPlanText(owner.workspace, filePath));
      if (request !== generation || identity !== key()) return;
      refreshed.set({ key: identity, plan });
      if (!plan) notice.set(tr("plan.invalidMetadata"));
    } catch (error) {
      if (request === generation && identity === key()) notice.set(localizeHostError(String(error instanceof Error ? error.message : error)));
    } finally {
      if (request === generation) reading.set(false);
    }
  }

  let previousKey = "";
  let hydratedKey = "";
  effect(() => {
    const identity = key();
    if (identity !== previousKey) {
      previousKey = identity;
      generation += 1;
      untracked(() => { reading.set(false); notice.set(""); copying.set(false); copied.set(false); });
    }
    if (!identity || !saved() || props.artifact.hasMetadata || hydratedKey === identity) return;
    hydratedKey = identity;
    untracked(() => void refresh());
  });

  effect(() => {
    const owner = props.owner;
    const file = openFile();
    const identity = key();
    if (!owner || !identity || !file || file.large || !sameWorkspace(owner.workspace) ||
      identity !== planBuildKey(owner.workspace, file.path)) return;
    const plan = parsedPlan(file.content);
    refreshed.set({ key: identity, plan });
  });

  function activate(): boolean {
    const owner = props.owner;
    if (owner && props.activate(owner)) return true;
    notice.set(tr("plan.buildNeedsSession"));
    return false;
  }

  function open(): void {
    const filePath = path();
    if (filePath && saved() && activate()) openInAuxPane("files", filePath);
  }

  async function copy(): Promise<void> {
    const owner = props.owner;
    const source = path();
    const target = destination();
    const identity = key();
    if (!owner || !source || !target || !saved() || copying() || copied()) return;
    copying.set(true);
    notice.set("");
    try {
      await copyRuntimePlan(owner, source, target);
      if (identity === key()) copied.set(true);
    } catch (error) {
      if (identity === key()) notice.set(localizeHostError(error instanceof Error ? error.message : String(error)));
    } finally {
      if (identity === key()) copying.set(false);
    }
  }

  return <View accessibilityLabel="transcript-plan" style={{ width: "100%", minWidth: 0,
    borderRadius: metrics.prominentRadius, borderCurve: "continuous", borderWidth: metrics.borderWidth,
    borderColor: palette().border, backgroundColor: designControlColors()?.toolCardSurface ?? palette().panelRaised }}>
    <View style={{ ...inset, flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <Icon name="file-text" size={metrics.iconSize} color={palette().textSecondary} />
      <View role={saved() && path() ? "button" : undefined} onPress={saved() && path() ? open : undefined}
        tooltip={saved() && path() ? tr("plan.view") : undefined} focusVisibleStyle={focusRingStyle()}
        style={{ flex: 1, minWidth: 0, cursor: saved() && path() ? "pointer" : "default" }}>
        <Text role="header" style={textStyle("label")}>{title()}</Text>
      </View>
      <If when={saved() && path()}>
        <IconButton icon="refresh" size="xs" tooltip={tr("plan.refresh")} disabled={reading()}
          accessibilityLabel="transcript-plan-refresh" onPress={() => void refresh()} />
        <IconButton icon="external-link" size="xs" tooltip={tr("plan.view")} accessibilityLabel="transcript-plan-open"
          onPress={open} />
      </If>
    </View>
    <If when={plan().overview}>
      {value => <View style={inset}>
        <MarkdownPreview markdown={value()} compact onLinkPress={event => {
          const owner = props.owner;
          const base = owner && path() && !runtimeUri(path()) ? dirnameOfPath(path(), owner.remote) : owner?.root ?? "";
          const link = resolveWorkspaceMarkdownLink(event.url, base, owner?.remote);
          if (link.kind === "external") void openUrl(link.target).catch(() => undefined);
          if (link.kind === "workspace" && activate()) openInAuxPane("files", link.target);
        }} />
      </View>}
    </If>
    <If when={plan().todos.length > 0}>
      <View style={{ ...inset, gap: space.sm, borderTopWidth: metrics.borderWidth, borderColor: palette().borderSubtle }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Text style={{ flex: 1, ...textStyle("caption") }}>
            {tr("plan.remaining", { count: formatCount(remaining()), total: formatCount(plan().todos.length) })}
          </Text>
          <IconButton size="xs" icon={expanded() ? "chevron-up" : "chevron-down"} active={expanded()}
            accessibilityLabel="transcript-plan-todos" tooltip={tr(expanded() ? "plan.collapseTodos" : "plan.expandTodos")}
            onPress={() => expanded.set(!expanded())} />
        </View>
        <If when={expanded()}><PlanTodoRows rows={plan().todos} /></If>
      </View>
    </If>
    <View style={{ ...inset, gap: space.sm, borderTopWidth: metrics.borderWidth, borderColor: palette().borderSubtle }}>
      <If when={notice()}>
        {message => <InlineBanner tone="warning" message={message()} onDismiss={() => notice.set("")} />}
      </If>
      <If when={activeWrite() || reading()}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Spinner size={12} />
          <Text style={textStyle("caption")}>{tr(reading() ? "plan.loading" : props.state === "confirmation" ? "plan.waitingApproval" : "plan.generating")}</Text>
        </View>
      </If>
      <If when={saved() && !path()}><Text style={textStyle("caption")}>{tr("plan.unavailable")}</Text></If>
      <If when={saved() && path()}>
        <If when={blocked() && (!status() || status() === "failed")}>
          <Text style={textStyle("caption")}>{blocked()}</Text>
        </If>
        <View style={{ flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: space.sm }}>
          <If when={destination()}>
            <Button size="sm" leadingIcon={copied() ? "check" : "folder-plus"} label={tr(copied() ? "plan.savedToProject" : "plan.saveToProject")}
              accessibilityLabel="transcript-plan-copy" loading={copying()} disabled={copied()} onPress={() => void copy()} />
          </If>
          <PlanBuildButton status={status()} blocked={blocked()} accessibilityLabel="transcript-plan-build"
            onPress={() => { if (props.owner && path() && saved()) void buildSavedPlan(path(), undefined, props.pane); }} />
        </View>
      </If>
    </View>
  </View>;
}
