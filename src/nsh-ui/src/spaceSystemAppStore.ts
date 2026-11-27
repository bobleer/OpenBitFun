import { computed, effect, signal, untracked } from "nsh";
import { backendConnection, invokeCommand } from "./bridge";
import { localizeHostError, tr } from "./i18n";
import { activeWorkspace, deviceContext } from "./state";
import { localizedSpace, spaceInCurrentCatalog, spaceWindowBlockedReason, type SpaceMeta } from "./spacesStore";
import { spaceSystemIconSvg } from "./ui/SpaceIcon";
import { dismissToast, pushToast } from "./ui/overlays";

export const spaceSystemAppScope = computed(() => ({
  device: deviceContext(),
  connection: backendConnection(),
  blocked: spaceWindowBlockedReason(),
}));

type Scope = ReturnType<typeof spaceSystemAppScope>;
type Action = "install" | "update" | "remove";

const operation = signal<{ appId: string; scope: Scope; progressToast: string } | null>(null);
export const spaceSystemAppBusy = computed(() => operation()?.appId ?? null);
export const spaceSystemAppRevision = signal(0);

effect(() => {
  const pending = operation();
  if (pending && pending.scope !== spaceSystemAppScope()) {
    untracked(() => dismissToast(pending.progressToast));
  }
});

export async function readSpaceSystemApp(appId: string): Promise<boolean> {
  const reply = await invokeCommand<{ paths: string[] }>("miniapp_presentation", { operation: "installation", appId });
  if (!Array.isArray(reply?.paths) || reply.paths.some(path => typeof path !== "string" || !path)) {
    throw new Error("Invalid system app installation status");
  }
  return reply.paths.length > 0;
}

export async function changeSpaceSystemApp(app: SpaceMeta, action: Action): Promise<void> {
  const scope = spaceSystemAppScope();
  if (scope.blocked || !spaceInCurrentCatalog(app.id) || operation()) return;

  const name = localizedSpace(app).name;
  const isCurrent = () => scope === spaceSystemAppScope();
  const progress = action === "remove" ? tr("spaces.systemApp.removing", { name })
    : action === "update" ? tr("spaces.systemApp.updating", { name })
    : tr("spaces.systemApp.adding", { name });
  const progressToast = pushToast(progress, "info", 0);
  operation.set({ appId: app.id, scope, progressToast });
  try {
    if (action === "remove") {
      await invokeCommand("miniapp_presentation", { operation: "uninstall", appId: app.id });
      if (isCurrent()) pushToast(tr("spaces.systemApp.removed", { name }), "success");
      return;
    }

    const workspace = activeWorkspace();
    const snapshot = await invokeCommand<{ instances: Array<{ appId: string; workspacePath: string | null }> }>(
      "miniapp_presentation", { operation: "snapshot" },
    );
    if (!isCurrent() || !spaceInCurrentCatalog(app.id)) return;
    const instance = snapshot.instances.find(item => item.appId === app.id);
    const workspacePath = instance ? instance.workspacePath : workspace?.rootPath || null;
    const installed = await invokeCommand<{ path: string }>("miniapp_presentation", {
      operation: "install", appId: app.id, workspacePath, iconSvg: spaceSystemIconSvg(app.icon),
    });
    if (typeof installed?.path !== "string" || !installed.path) {
      throw new Error("System app installation returned no launcher path");
    }
    if (isCurrent()) {
      const path = installed.path;
      pushToast(tr(action === "update" ? "spaces.systemApp.updated" : "spaces.systemApp.added", { name, path }), "success");
    }
  } catch (error) {
    if (isCurrent()) {
      const message = localizeHostError(error instanceof Error ? error.message : error);
      const key = action === "remove" ? "spaces.systemApp.removeFailed"
        : action === "update" ? "spaces.systemApp.updateFailed" : "spaces.systemApp.addFailed";
      pushToast(tr(key, { name, error: message }), "error");
    }
  } finally {
    dismissToast(progressToast);
    operation.set(null);
    spaceSystemAppRevision.update(revision => revision + 1);
  }
}
