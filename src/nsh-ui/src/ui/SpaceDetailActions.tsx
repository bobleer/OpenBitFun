import { effect, signal, untracked } from "nsh";
import { localizeHostError, tr } from "../i18n";
import { changeSpaceSystemApp, readSpaceSystemApp, spaceSystemAppBusy,
  spaceSystemAppRevision, spaceSystemAppScope } from "../spaceSystemAppStore";
import { pinnedSpaceIds, setSpacePinned, spacePinsReady } from "../spaceNavigationStore";
import { openSpaceWindow, spaceInCurrentCatalog, spaceOpening, spaceWindowBlockedReason, type SpaceMeta } from "../spacesStore";
import { deviceContext } from "../state";
import { compactLayout, layout } from "../theme";
import { Button } from "./primitives";

export function SpacePinButton(props: { appId: string; accessibilityLabel: string }) {
  const pinned = () => pinnedSpaceIds().includes(props.appId);
  return <Button label={tr(pinned() ? "spaces.unpinFromSidebar" : "spaces.pinToSidebar")}
    leadingIcon="pin" variant="outline" size={compactLayout() ? "md" : "sm"}
    accessibilityLabel={props.accessibilityLabel} disabled={!spacePinsReady() || !spaceInCurrentCatalog(props.appId)}
    style={compactLayout() ? { minHeight: layout.touchTarget } : undefined}
    onPress={() => {
      if (spaceInCurrentCatalog(props.appId)) setSpacePinned(props.appId, !pinned(), deviceContext());
    }} />;
}

export function SpaceWindowButton(props: { appId: string; accessibilityLabel: string; disabled?: boolean }) {
  return <If when={!spaceWindowBlockedReason()}>
    <Button label={tr("spaces.openWindow")} leadingIcon="external-link" variant="outline"
      size={compactLayout() ? "md" : "sm"} accessibilityLabel={props.accessibilityLabel}
      disabled={props.disabled || spaceOpening() !== null || !spaceInCurrentCatalog(props.appId)}
      style={compactLayout() ? { minHeight: layout.touchTarget } : undefined}
      onPress={() => {
        if (spaceInCurrentCatalog(props.appId)) void openSpaceWindow(props.appId);
      }} />
  </If>;
}

export function SpaceSystemAppActions(props: { app: () => SpaceMeta }) {
  const installed = signal<boolean | null>(null);
  const error = signal("");
  const retry = signal(0);
  const size = () => compactLayout() ? "md" : "sm";
  effect(() => {
    const scope = spaceSystemAppScope();
    const appId = props.app().id;
    void spaceSystemAppRevision();
    void retry();
    installed.set(null);
    error.set("");
    if (scope.blocked) return;
    let current = true;
    untracked(() => {
      void readSpaceSystemApp(appId).then(value => {
        if (current && scope === spaceSystemAppScope()) installed.set(value);
      }).catch((cause: unknown) => {
        if (current && scope === spaceSystemAppScope()) {
          error.set(localizeHostError(cause instanceof Error ? cause.message : cause));
        }
      });
    });
    return () => { current = false; };
  });

  return <If when={!spaceSystemAppScope().blocked}>
    <If when={error()} else={
      <>
        <Button label={tr(installed() ? "spaces.systemApp.update" : "spaces.systemApp.add")}
          leadingIcon={installed() ? "refresh" : "download"} variant="outline" size={size()}
          accessibilityLabel="space-system-app-install" loading={installed() === null}
          disabled={installed() === null || spaceSystemAppBusy() !== null}
          onPress={() => void changeSpaceSystemApp(props.app(), installed() ? "update" : "install")} />
        <If when={installed() === true}>
          <Button label={tr("spaces.systemApp.remove")} leadingIcon="trash" variant="outline" size={size()}
            tooltip={tr("spaces.systemApp.removeHint")} accessibilityLabel="space-system-app-remove"
            disabled={spaceSystemAppBusy() !== null}
            onPress={() => void changeSpaceSystemApp(props.app(), "remove")} />
        </If>
      </>
    }>
      {message => <Button label={tr("spaces.systemApp.retry")} leadingIcon="refresh" variant="outline"
        size={size()} tooltip={message()} accessibilityLabel="space-system-app-retry"
        onPress={() => retry.update(value => value + 1)} />}
    </If>
  </If>;
}
