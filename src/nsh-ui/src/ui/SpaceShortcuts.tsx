import { cleanup, computed, effect, untracked, View } from "nsh";
import { connectionState } from "../bridge";
import { tr } from "../i18n";
import { spacesView } from "../miniAppMarketStore";
import { loadSpacePins, pinnedSpaces, pinnedSpaceIds, setSpacePinned } from "../spaceNavigationStore";
import { loadSpaces, spacesCatalogDevice, subscribeSpaceEvents } from "../spacesStore";
import { openInstalledSpace, openSpace, spaceOpenBlockedReason } from "../spaceViewStore";
import { activeScene, deviceContext, libraryTab, openLibrary } from "../state";
import { compactLayout, layout, palette, space } from "../theme";
import { SpaceIcon } from "./SpaceIcon";
import { IconButton } from "./primitives";
import { SidebarRow } from "./SidebarRow";

const activeShortcutId = computed(() => {
  const current = openSpace();
  return activeScene() === "library" && libraryTab() === "spaces"
    && current?.deviceId === deviceContext() && pinnedSpaces().some(item => item.id === current.appId)
    ? current.appId
    : null;
});

export function spaceShortcutActive(): boolean {
  return activeShortcutId() !== null;
}

export function SpaceShortcuts(props: { onNavigate?: () => void }) {
  void loadSpacePins();
  const catalogScope = computed(() => pinnedSpaceIds().length > 0 ? deviceContext() : null);
  effect(() => {
    if (catalogScope() === null || connectionState() !== "connected") return;
    untracked(() => void loadSpaces());
    cleanup(subscribeSpaceEvents());
  });

  return (
    <If when={pinnedSpaces().length > 0}>
      <View accessibilityLabel="space-shortcuts" style={{ gap: space.hair, marginBottom: space.sm }}>
        <Each of={pinnedSpaces()} key={item => item.id}>
          {item => (
            <View style={{ flexDirection: "row", alignItems: "center", minWidth: 0 }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <SidebarRow
                  label={item().name}
                  leading={<SpaceIcon icon={item().icon} color={palette().chromeTextMuted} />}
                  active={activeShortcutId() === item().id}
                  accessibilityLabel={`space-shortcut-${item().id}`}
                  disabled={Boolean(spaceOpenBlockedReason())}
                  tooltip={spaceOpenBlockedReason() || item().name}
                  touchSized={compactLayout()}
                  onPress={() => {
                    const owner = deviceContext();
                    if (spacesCatalogDevice() !== owner || spaceOpenBlockedReason()) return;
                    openLibrary("spaces");
                    spacesView.set("library");
                    openInstalledSpace(item(), owner);
                    props.onNavigate?.();
                  }}
                />
              </View>
              <IconButton
                icon="close"
                size={compactLayout() ? "md" : "xs"}
                surface="chrome"
                tooltip={tr("spaces.unpinNamed", { name: item().name })}
                accessibilityLabel={`space-shortcut-remove-${item().id}`}
                style={compactLayout() ? { width: layout.touchTarget, height: layout.touchTarget } : undefined}
                onPress={() => setSpacePinned(item().id, false, deviceContext())}
              />
            </View>
          )}
        </Each>
      </View>
    </If>
  );
}
