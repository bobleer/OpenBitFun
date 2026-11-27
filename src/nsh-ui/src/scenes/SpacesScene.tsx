import { cleanup, computed, effect, Image, Scroll, signal, Text, untracked, View, type JSX, type ScrollRef, type ViewRef } from "nsh";
import { backendConnection } from "../bridge";
import { rendererAssets } from "../documentRenderers";
import { Editor } from "nsh/base";
import { formatCount, formatPlural } from "../format";
import { localizeHostError, tr } from "../i18n";
import { installedSpaceRows } from "../installedSpaceCatalog";
import {
  cancelDeleteSpace,
  closeSpaceInspector,
  confirmDeleteSpace,
  confirmingDeleteSpaceId,
  hasCurrentSpaceCatalog,
  inspectSpace,
  localizedSpace,
  loadSpaces,
  requestDeleteSpace,
  runningSpaceWorkers,
  runningWorkerSet,
  selectedSpaceDetail,
  selectedSpaceId,
  selectedSpaceSourceCode,
  selectedSpaceVersions,
  spaceInspectorBusy,
  spaces,
  spacesBusy,
  spacesCatalogDevice,
  spacesError,
  spaceInCurrentCatalog,
  spacesNotice,
  spaceSourceTab,
  spacesInitialLoad,
  stopSpaceWorker,
  subscribeSpaceEvents,
  spacePermissionBadges,
  type SpaceMeta,
  type SpaceSourceTab,
  openSpaceWindow,
  spaceOpening,
  spaceWindowBlockedReason,
} from "../spacesStore";
import { loadSpacePins, pinnedSpaceIds, setSpacePinned, spacePinsReady } from "../spaceNavigationStore";
import {
  compactLayout,
  fontMono,
  layout,
  palette,
  radii,
  space,
  textLineHeight,
  textSize,
  textStyle,
} from "../theme";
import { deviceContext } from "../state";
import { LibraryToolbar, libraryBodyStyle } from "./LibraryChrome";
import { CatalogCard } from "../ui/CatalogCard";
import { Icon } from "../ui/icons";
import { createEditorStyles, inferCodeLanguage } from "../ui/markdown";
import { Spinner } from "../ui/motion";
import { ModalDialog, type DropdownMenuItem } from "../ui/overlays";
import {
  MarketListingDetails,
  MiniAppMarketView,
  MiniAppSubmissionsView,
  PackageImportModal,
  SpaceCatalogToolbar,
} from "../ui/MiniAppMarket";
import {
  clearDeletedMarketInstall,
  closeMarketListing,
  enterMarket,
  installedMarketSummaries,
  installedMarketSummariesSupported,
  loadInstalledMarketSummaries,
  loadMarketOrigins,
  loadSubmissions,
  marketDetailSlug,
  marketDetailTarget,
  marketOrigins,
  openMarketListing,
  openPackageImport,
  spacesView,
  type MarketCategory,
  type MarketSort,
  type SpacesView,
} from "../miniAppMarketStore";
import {
  Badge,
  Button,
  ConfigSection,
  IconButton,
  InlineBanner,
  InlineDeleteConfirm,
  SegmentedTabs,
  type SegmentedTabOption,
} from "../ui/primitives";
import {
  GalleryGrid,
  GallerySkeleton,
  MoreMenu,
  StudioBody,
  StudioEmpty,
  StudioHeader,
  StudioSection,
  trackStudioWidth,
} from "../ui/studio";
import { CardsSection } from "../ui/cardView"; // wave22-p3
import { SpacePinButton, SpaceSystemAppActions, SpaceWindowButton } from "../ui/SpaceDetailActions";
import { SpaceIcon, spaceIconName } from "../ui/SpaceIcon";
import { changeSpaceSystemApp, spaceSystemAppBusy, spaceSystemAppScope } from "../spaceSystemAppStore";
import { cardsDeviceForLibrary } from "../desktopCardsStore"; // wave22-p3
import { ElsewhereList, SpacePage } from "../ui/miniAppFrame"; // wave22-p4
import {
  accountCatalogLoading,
  closeSpacePage,
  openInstalledSpace,
  loadAccountCatalog,
  openSpace,
  openSpacePage,
  spaceOpenBlockedReason,
  spacesElsewhere,
} from "../spaceViewStore"; // wave22-p4

function sourceTabs(): ReadonlyArray<SegmentedTabOption<SpaceSourceTab>> {
  return [
    { value: "html", label: tr("spaces.tabHtml") },
    { value: "css", label: tr("spaces.tabCss") },
    { value: "ui_js", label: tr("spaces.tabUiJs") },
    { value: "worker_js", label: tr("spaces.tabWorkerJs") },
  ];
}

/** The label of a host permission badge id. */
function localizePermission(id: string): string {
  if (id === "filesystem") return tr("spaces.permFilesystem");
  if (id === "shell") return tr("spaces.permShell");
  if (id === "network") return tr("spaces.permNetwork");
  if (id === "node_worker") return tr("spaces.permNodeWorker");
  if (id === "ai_bridge") return tr("spaces.permAiBridge");
  if (id === "agent_bridge") return tr("spaces.permAgentBridge");
  if (id === "sandboxed_ui") return tr("spaces.permSandboxedUi");
  return id;
}

const INSPECTOR_TAG_CAP = 8;

function sourceTabFilename(tab: SpaceSourceTab): string {
  if (tab === "html") return "index.html";
  if (tab === "css") return "styles.css";
  if (tab === "ui_js") return "ui.js";
  return "worker.js";
}

function sourceLineCount(code: string): number {
  if (!code) return 0;
  return code.split(/\r?\n/).length;
}

export { spaceIconName };

/** A quiet inline list: "Permissions  Filesystem · Network". Each item is its own text. */
function QuietList(props: { label: string; items: ReadonlyArray<string>; overflow?: string }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: space.xs, rowGap: space.hair, minWidth: 0 }}>
      <Text
        style={{
          color: palette().textMuted,
          fontSize: textSize(12),
          lineHeight: textLineHeight(12, 1.45),
          marginRight: space.xs,
        }}
      >
        {props.label}
      </Text>
      <Each of={props.items} key="index">
        {(item, index) => (
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.xs }}>
            <If when={index() > 0}>
              <Text style={{ color: palette().textMuted, fontSize: textSize(12), lineHeight: textLineHeight(12, 1.45) }}>
                ·
              </Text>
            </If>
            <Text
              style={{
                color: palette().textSecondary,
                fontSize: textSize(12),
                lineHeight: textLineHeight(12, 1.45),
              }}
            >
              {item()}
            </Text>
          </View>
        )}
      </Each>
      <If when={props.overflow ?? ""}>
        {more => (
          <Text style={{ color: palette().textMuted, fontSize: textSize(12), lineHeight: textLineHeight(12, 1.45) }}>
            {more()}
          </Text>
        )}
      </If>
    </View>
  );
}

function viewTabs(): ReadonlyArray<SegmentedTabOption<SpacesView>> {
  return [
    { value: "library", label: tr("spaces.p4.apps"), accessibilityLabel: "spaces-view-library" },
    { value: "cards", label: tr("spaces.p4.cards"), accessibilityLabel: "spaces-view-cards" },
    { value: "market", label: tr("market.viewMarket"), accessibilityLabel: "spaces-view-market" },
    { value: "submissions", label: tr("market.viewSubmissions"), accessibilityLabel: "spaces-view-submissions" },
  ];
}

function refreshCurrentView(): void {
  const view = spacesView();
  if (view === "market") enterMarket();
  else if (view === "submissions") void loadSubmissions();
  else if (view === "library") {
    void loadSpaces();
    void loadMarketOrigins();
    void loadAccountCatalog();
  }
}

function openElsewhereSpace(appId: string, deviceId: string): void {
  const app = spacesElsewhere().find(item => item.appId === appId);
  if (!app) return;
  openSpacePage({
    appId,
    name: app.name,
    deviceId,
    devices: app.devices.map(device => device.deviceId),
    needsDevice: app.needsDevice,
  });
}

async function deleteSpaceAndUpdateListing(appId: string): Promise<void> {
  if (spaceSystemAppBusy() === appId) return;
  const device = deviceContext();
  const connection = backendConnection();
  const isCurrent = () => device === deviceContext() && connection === backendConnection();
  if (!await confirmDeleteSpace(appId) || !isCurrent()) return;
  clearDeletedMarketInstall(appId);
  await loadSpacePins();
  if (isCurrent()) setSpacePinned(appId, false, device);
}

function spaceMenuItems(space: SpaceMeta, running: boolean, onManage?: () => void): DropdownMenuItem[] {
  const owner = deviceContext();
  const pinned = pinnedSpaceIds().includes(space.id);
  const systemAppBlocked = Boolean(spaceSystemAppScope().blocked);
  const systemAppBusy = spaceSystemAppBusy();
  return [
    {
      id: "open",
      label: tr("spaces.p4.open"),
      icon: "layout-grid",
      disabled: Boolean(spaceOpenBlockedReason()),
      accessibilityLabel: `space-menu-open-inline-${space.id}`,
      onSelect: () => openInstalledSpace({ id: space.id, name: localizedSpace(space).name }, owner),
    },
    {
      id: "open-window",
      label: tr("spaces.openWindow"),
      icon: "external-link",
      disabled: Boolean(spaceWindowBlockedReason()) || spaceOpening() !== null,
      accessibilityLabel: `space-menu-open-${space.id}`,
      onSelect: () => void openSpaceWindow(space.id),
    },
    {
      id: "add-system-app",
      label: tr("spaces.systemApp.add"),
      icon: "download",
      hint: systemAppBlocked ? tr("spaces.systemApp.unsupported") : undefined,
      disabled: systemAppBlocked || systemAppBusy !== null,
      accessibilityLabel: `space-menu-system-add-${space.id}`,
      onSelect: () => void changeSpaceSystemApp(space, "install"),
    },
    {
      id: "inspect",
      label: tr("spaces.inspectSource"),
      icon: "code",
      accessibilityLabel: `space-menu-inspect-${space.id}`,
      onSelect: () => void inspectSpace(space.id),
    },
    ...(onManage ? [{
      id: "manage",
      label: tr("market.manage"),
      icon: "layout-grid" as const,
      accessibilityLabel: `space-menu-manage-${space.id}`,
      onSelect: onManage,
    }] : []),
    {
      id: "pin",
      label: tr(pinned ? "spaces.unpinFromSidebar" : "spaces.pinToSidebar"),
      icon: "pin",
      disabled: !spacePinsReady() || spacesCatalogDevice() !== owner,
      accessibilityLabel: `space-menu-pin-${space.id}`,
      onSelect: () => setSpacePinned(space.id, !pinned, owner),
    },
    {
      id: "stop",
      label: tr("spaces.stopWorkerTitle"),
      icon: "stop",
      disabled: !running || spacesBusy(),
      accessibilityLabel: `space-menu-stop-${space.id}`,
      onSelect: () => void stopSpaceWorker(space.id),
    },
    { id: "sep", label: "", separator: true },
    {
      id: "delete",
      label: tr("spaces.deleteSpace"),
      icon: "trash",
      danger: true,
      disabled: spacesBusy() || systemAppBusy === space.id,
      confirmDelete: true,
      confirmAccessibilityLabel: `space-delete-confirm-${space.id}`,
      accessibilityLabel: `space-menu-delete-${space.id}`,
      onSelect: () => void deleteSpaceAndUpdateListing(space.id),
    },
  ];
}

function SpaceCard(props: {
  space: () => SpaceMeta;
  updateAvailable: boolean;
  onManage?: () => void;
  onDetails: () => void;
  onRef: (node: ViewRef | null) => void;
}) {
  const app = props.space;
  const copy = () => localizedSpace(app());
  const running = () => runningWorkerSet().has(app().id);
  return (
    <CatalogCard
      testID={`space-details-${app().id}`}
      label={tr("spaces.detail.open", { name: copy().name })}
      description={copy().description}
      viewRef={props.onRef}
      onOpen={props.onDetails}
      actionPlacement="trailing"
      actions={<View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
        <IconButton icon="play" size={compactLayout() ? "lg" : "sm"}
          accessibilityLabel={`space-open-${app().id}`} tooltip={spaceOpenBlockedReason() || tr("spaces.p4.open")}
          disabled={Boolean(spaceOpenBlockedReason())}
          onPress={() => openInstalledSpace({ id: app().id, name: copy().name })} />
        <MoreMenu accessibilityLabel={`space-more-${app().id}`} tooltip={tr("spaces.spaceActions")}
          minWidth={210} items={spaceMenuItems(app(), running(), props.onManage)} />
      </View>}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minWidth: 0 }}>
        <SpaceIcon icon={app().icon} color={palette().textSecondary} size={24} />
        <Text style={{ ...textStyle("sectionTitle"), flexShrink: 1, numberOfLines: 1, textOverflow: "ellipsis" }}>
          {copy().name}
        </Text>
      </View>
      <If when={running() || props.updateAvailable}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
          <If when={running()}>
            <View accessibilityLabel={`space-running-${app().id}`}>
              <Badge tone="accent" label={tr("spaces.workerRunning")} />
            </View>
          </If>
          <If when={props.updateAvailable}>
            <Badge tone="warning" accessibilityLabel={`space-update-${app().id}`}
              label={tr("market.updateAvailable")} />
          </If>
        </View>
      </If>
      <If when={copy().description}>
        {description => <Text style={{ ...textStyle("body"), color: palette().textSecondary, numberOfLines: 2 }}>
          {description()}
        </Text>}
      </If>
    </CatalogCard>
  );
}

function SpaceDetailsFrame(props: {
  accessibilityLabel: string;
  backLabel: string;
  backText?: string;
  onBack: () => void;
  children: JSX.Element;
}) {
  return (
    <Scroll smoothWheel accessibilityLabel={props.accessibilityLabel} style={{ flex: 1, minHeight: 0 }}>
      <StudioBody style={libraryBodyStyle()}>
        <View style={{ paddingTop: space.lg, alignSelf: "flex-start" }}>
          <Button label={props.backText ?? tr("spaces.p4.back")} leadingIcon="chevron-left" variant="ghost"
            size={compactLayout() ? "md" : "sm"} accessibilityLabel={props.backLabel} onPress={props.onBack} />
        </View>
        {props.children}
      </StudioBody>
    </Scroll>
  );
}

function InstalledSpaceDetails(props: {
  space: () => SpaceMeta;
  backText?: string;
  onBack: () => void;
  onViewListing?: (listingId: string) => void;
  listingButtonRef?: (node: ViewRef | null) => void;
}) {
  const app = props.space;
  const copy = () => localizedSpace(app());
  const origin = () => Object.values(marketOrigins()).find(value => value.appId === app().id);
  const source = () => tr(app().id.startsWith("builtin-") ? "spaces.detail.builtIn"
    : origin() ? "spaces.detail.market" : "spaces.detail.installed");
  const version = () => `v${origin()?.releaseNumber ?? app().version}`;
  const running = () => runningWorkerSet().has(app().id);
  const launch = () => openInstalledSpace({ id: app().id, name: copy().name });
  const actionSize = () => compactLayout() ? "md" : "sm";
  return (
    <SpaceDetailsFrame accessibilityLabel="space-installed-details" backLabel="space-detail-back"
      backText={props.backText} onBack={props.onBack}>
        <View style={{ gap: space.lg }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
            <SpaceIcon icon={app().icon} color={palette().textSecondary} size={32} />
            <Text role="header" style={{ ...textStyle("pageTitle"), flex: 1, minWidth: 0 }}>{copy().name}</Text>
          </View>
          <If when={copy().description}>
            {description => <Text style={textStyle("prose")}>{description()}</Text>}
          </If>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
            <Badge tone="neutral" label={source()} />
            <Badge tone="neutral" label={version()} />
            <Each of={[...new Set(copy().tags)]} key={tag => tag}>
              {tag => <Badge tone="neutral" label={tag()} />}
            </Each>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            <Button label={tr("spaces.p4.open")} leadingIcon="play" variant="primary" size={actionSize()}
              accessibilityLabel="space-detail-launch" disabled={Boolean(spaceOpenBlockedReason())} onPress={launch} />
            <SpacePinButton appId={app().id} accessibilityLabel="space-detail-pin" />
            <SpaceWindowButton appId={app().id} accessibilityLabel="space-detail-window" />
            <SpaceSystemAppActions app={app} />
            <If when={props.onViewListing && origin()?.listingId}>
              {listingId => <Button label={tr("market.viewListing")} leadingIcon="package"
                variant="outline" size={actionSize()} accessibilityLabel="space-detail-market-listing"
                buttonRef={props.listingButtonRef} onPress={() => props.onViewListing?.(listingId())} />}
            </If>
            <Button label={tr("spaces.inspectSource")} leadingIcon="code" variant="outline" size={actionSize()}
              accessibilityLabel="space-detail-source" onPress={() => void inspectSpace(app().id)} />
            <If when={running()}>
              <Button label={tr("spaces.stopWorkerTitle")} leadingIcon="stop" variant="outline" size={actionSize()} disabled={spacesBusy()}
                accessibilityLabel="space-detail-stop" onPress={() => void stopSpaceWorker(app().id)} />
            </If>
            <InlineDeleteConfirm label={tr("spaces.deleteSpace")} icon="trash" variant="danger" size={actionSize()}
              confirming={confirmingDeleteSpaceId() === app().id} disabled={spacesBusy() || spaceSystemAppBusy() === app().id}
              onConfirmingChange={next => next ? requestDeleteSpace(app().id) : cancelDeleteSpace()}
              accessibilityLabel="space-detail-delete" confirmAccessibilityLabel="space-detail-delete-confirm"
              onConfirm={() => void deleteSpaceAndUpdateListing(app().id)} />
          </View>
          <If when={spaceOpenBlockedReason()}>
            {reason => <InlineBanner tone="neutral" message={reason()} />}
          </If>
          <If when={spacesError()}>
            {error => <InlineBanner tone="danger" message={localizeHostError(error())} />}
          </If>
        </View>
        <If when={rendererAssets()?.spaceShowcases?.[app().id]}>
          {showcase => <Image src={showcase()} accessibilityLabel={tr("spaces.detail.showcase", { name: copy().name })}
            style={{ width: "100%", aspectRatio: 16 / 9, borderRadius: radii.lg, backgroundColor: palette().surfaceSubtle }} />}
        </If>
        <StudioSection title={tr("spaces.polish.permissions")}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
            <Each of={spacePermissionBadges(app())} key={badge => badge}>
              {badge => <Badge tone="neutral" label={localizePermission(badge())} />}
            </Each>
            <If when={spacePermissionBadges(app()).length === 0}>
              <Text style={textStyle("body")}>{tr("spaces.detail.noPermissions")}</Text>
            </If>
          </View>
        </StudioSection>
        <StudioSection title={tr("spaces.detail.information")}>
          <QuietList label={tr("spaces.detail.version")} items={[version()]} />
          <QuietList label={tr("spaces.detail.source")} items={[source()]} />
          <QuietList label={tr("spaces.detail.status")} items={[tr(running() ? "spaces.workerRunning" : "spaces.detail.installed")]} />
        </StudioSection>
    </SpaceDetailsFrame>
  );
}

function SpaceInspectorModal() {
  const lineCount = () => sourceLineCount(selectedSpaceSourceCode());
  const copy = () => {
    const detail = selectedSpaceDetail();
    return detail ? localizedSpace(detail) : undefined;
  };
  const visibleTags = () => {
    const tags = copy()?.tags;
    return tags?.length ? tags : undefined;
  };

  return (
    <ModalDialog
      open={Boolean(selectedSpaceId())}
      title={copy()?.name ?? tr("spaces.inspectTitle")}
      subtitle={
        selectedSpaceDetail()
          ? `${selectedSpaceDetail()!.category} · v${selectedSpaceDetail()!.version} · ${selectedSpaceDetail()!.runtimeProfile}`
          : tr("spaces.loadingMeta")
      }
      size="lg"
      onClose={() => closeSpaceInspector()}
      footer={
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm }}>
          <If when={Boolean(selectedSpaceId())}>
            <InlineDeleteConfirm
              confirming={Boolean(confirmingDeleteSpaceId() && confirmingDeleteSpaceId() === selectedSpaceId())}
              onConfirmingChange={next => {
                const id = selectedSpaceId();
                if (next && id) requestDeleteSpace(id);
                else cancelDeleteSpace();
              }}
              label={tr("spaces.deleteSpace")}
              icon="trash"
              variant="danger"
              size="md"
              disabled={spacesBusy() || spaceSystemAppBusy() === selectedSpaceId()}
              accessibilityLabel="space-inspector-delete"
              confirmAccessibilityLabel="space-inspector-delete-confirm"
              onConfirm={() => {
                const id = selectedSpaceId();
                if (id) void deleteSpaceAndUpdateListing(id);
              }}
            />
          </If>

          <View style={{ flex: 1, minWidth: space.sm }} />

          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm, flexShrink: 0 }}>
            <If when={Boolean(selectedSpaceId() && runningWorkerSet().has(selectedSpaceId()!))}>
              <Button
                label={tr("spaces.stopWorkerTitle")}
                variant="outline"
                size="md"
                leadingIcon="stop"
                disabled={spacesBusy()}
                accessibilityLabel="space-inspector-stop"
                style={compactLayout() ? { minHeight: layout.touchTarget } : undefined}
                onPress={() => {
                  const id = selectedSpaceId();
                  if (id) void stopSpaceWorker(id);
                }}
              />
            </If>
            <Button
              label={tr("common.close")}
              variant="secondary"
              size="md"
              accessibilityLabel="space-inspector-close"
              style={compactLayout() ? { minHeight: layout.touchTarget } : undefined}
              onPress={() => closeSpaceInspector()}
            />
            <If when={Boolean(selectedSpaceId()) && !spaceWindowBlockedReason()}>
              <Button
                label={tr("spaces.openWindow")}
                variant="primary"
                size="md"
                leadingIcon="external-link"
                disabled={spaceOpening() !== null}
                accessibilityLabel="space-inspector-open"
                style={compactLayout() ? { minHeight: layout.touchTarget } : undefined}
                onPress={() => {
                  const id = selectedSpaceId();
                  if (id) void openSpaceWindow(id);
                }}
              />
            </If>
          </View>
        </View>
      }
    >
      <View style={{ gap: space.lg }}>
        {/* Calm inline note instead of heavy notice rectangle */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm,
            paddingHorizontal: space.hair,
          }}
        >
          <Icon name="info" size={14} color={palette().textMuted} />
          <Text
            style={{
              flex: 1,
              minWidth: 0,
              color: palette().textMuted,
              fontSize: textSize(12),
              lineHeight: textLineHeight(12, 1.44),
            }}
          >
            {tr("spaces.inspectorWebviewHint")}
          </Text>
        </View>

        <If when={spaceInspectorBusy()}>
          <View style={{ padding: 24, alignItems: "center", gap: 8 }}>
            <Spinner size={18} />
            <Text
              style={{
                color: palette().textMuted,
                fontSize: textSize(12),
                lineHeight: textLineHeight(12, 1.4),
              }}
            >
              {tr("spaces.loadingSource")}
            </Text>
          </View>
        </If>

        <If when={!spaceInspectorBusy() && !selectedSpaceDetail() && Boolean(spacesError())}>
          <InlineBanner tone="danger" message={localizeHostError(spacesError())} />
        </If>

        <If when={!spaceInspectorBusy() ? selectedSpaceDetail() : null}>
          {detail => (
            <View style={{ gap: 16 }}>
              <Text
                style={{
                  minWidth: 0,
                  color: palette().textSecondary,
                  fontSize: textSize(13),
                  lineHeight: textLineHeight(13, 1.5),
                }}
              >
                {copy()?.description || tr("spaces.noManifestDesc")}
              </Text>

              <View style={{ gap: space.xs }}>
                <QuietList
                  label={tr("spaces.polish.permissions")}
                  items={spacePermissionBadges(detail()).map(localizePermission)}
                />
                <If when={visibleTags()}>
                  {tags => <QuietList
                    label={tr("spaces.polish.tags")}
                    items={tags().slice(0, INSPECTOR_TAG_CAP)}
                    overflow={
                      tags().length > INSPECTOR_TAG_CAP
                        ? tr("spaces.overflowTags", {
                            count: formatCount(tags().length - INSPECTOR_TAG_CAP),
                          })
                        : ""
                    }
                  />}
                </If>
              </View>

              <If when={detail().originalPrompt}>
                {prompt => (
                  <ConfigSection title={tr("spaces.originalPrompt")}>
                    <Text
                      style={{
                        minWidth: 0,
                        color: palette().text,
                        fontSize: textSize(13),
                        lineHeight: textLineHeight(13, 1.52),
                      }}
                    >
                      {prompt()}
                    </Text>
                  </ConfigSection>
                )}
              </If>

              <If when={selectedSpaceVersions().length > 0}>
                <ConfigSection
                  title={tr("spaces.savedVersions", {
                    count: formatCount(selectedSpaceVersions().length),
                  })}
                >
                  <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: space.md, rowGap: space.xs }}>
                    <Each of={selectedSpaceVersions()} key={v => v.version}>
                      {ver => (
                        <Text
                          style={{
                            color:
                              ver().label === `v${detail().version}` ? palette().text : palette().textSecondary,
                            fontSize: textSize(13),
                            fontWeight: ver().label === `v${detail().version}` ? "600" : "400",
                            fontVariant: ["tabular-nums"],
                            lineHeight: textLineHeight(13, 1.4),
                          }}
                        >
                          {ver().label}
                        </Text>
                      )}
                    </Each>
                  </View>
                </ConfigSection>
              </If>

              {/* Syntax-highlighted Read-Only Source Bundle Viewer */}
              <View style={{ gap: space.sm }}>
                <Scroll smoothWheel horizontal scrollbar={false} style={{ maxWidth: "100%", minWidth: 0 }}>
                  <SegmentedTabs
                    size="sm"
                    options={sourceTabs()}
                    value={spaceSourceTab()}
                    onChange={next => spaceSourceTab.set(next)}
                  />
                </Scroll>

                <View
                  style={{
                    borderRadius: radii.md,
                    borderCurve: "continuous",
                    borderWidth: 1,
                    borderColor: palette().borderSubtle,
                    backgroundColor: palette().canvas,
                    overflow: "hidden",
                  }}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: space.sm,
                      paddingHorizontal: space.md,
                      paddingVertical: space.sm,
                      borderBottomWidth: 1,
                      borderColor: palette().borderSubtle,
                    }}
                  >
                    <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, minWidth: 0 }}>
                      <Icon name="file-code" size={12} color={palette().textMuted} />
                      <Text
                        style={{
                          minWidth: 0,
                          color: palette().textSecondary,
                          fontFamily: fontMono(),
                          fontSize: textSize(12),
                          fontWeight: "500",
                          lineHeight: textLineHeight(12, 1.35),
                          numberOfLines: 1,
                          textOverflow: "ellipsis",
                        }}
                      >
                        {sourceTabFilename(spaceSourceTab())}
                      </Text>
                    </View>
                    <Text
                      style={{
                        flexShrink: 0,
                        color: palette().textMuted,
                        fontFamily: fontMono(),
                        fontSize: textSize(12),
                        fontVariant: ["tabular-nums"],
                        lineHeight: textLineHeight(12, 1.35),
                      }}
                    >
                      {formatPlural(lineCount(), "format.lineOne", "format.lineOther")}
                    </Text>
                  </View>

                  <View style={{ height: 280 }}>
                    <Editor
                      value={selectedSpaceSourceCode()}
                      language={inferCodeLanguage(sourceTabFilename(spaceSourceTab()))}
                      readOnly={true}
                      lineNumbers={true}
                      fontSize={textSize(12)}
                      softWrap={true}
                      styles={createEditorStyles()}
                      accessibilityLabel="space-source-editor"
                      style={{ flex: 1 }}
                    />
                  </View>
                </View>
              </View>
            </View>
          )}
        </If>
      </View>
    </ModalDialog>
  );
}

function installedSummary(): string {
  const installed = tr("spaces.installedCount", { count: formatCount(spaces().length) });
  const running = runningSpaceWorkers().length;
  return running > 0
    ? `${installed} · ${formatPlural(running, "spaces.activeWorkersOne", "spaces.activeWorkers")}`
    : installed;
}

/** The Library's Spaces gallery: `minmax(280, 1fr)` columns (visual spec §4.8). */
const SPACE_GALLERY_MIN_COLUMN = 280;

export function SpacesScene(props: { embedded?: boolean }) {
  void loadSpacePins();
  const installedDetail = signal<{ appId: string; from: "library" | "market" } | null>(null);
  const marketFromAppCard = signal<string | null>(null);
  const query = signal("");
  const category = signal<MarketCategory>("all");
  const installedSort = signal<MarketSort>("downloads");
  const keyword = computed(() => query().trim().toLowerCase());
  const hasFilters = () => Boolean(keyword()) || category() !== "all";
  const matchesCategory = (value: string) => category() === "all" || value?.toLowerCase() === category();
  const matchesText = (fields: string[]) => fields.some(value => value?.toLowerCase().includes(keyword()));
  const installedListingIds = computed(() => {
    if (!hasCurrentSpaceCatalog()) return [];
    const appIds = new Set(spaces().map(app => app.id));
    return Object.values(marketOrigins()).filter(origin => appIds.has(origin.appId))
      .map(origin => origin.listingId).sort();
  });
  const rankingsAvailable = () => installedMarketSummaries().items.size > 0;
  const effectiveSort = (): MarketSort => rankingsAvailable() ? installedSort() : "newest";
  const visibleInstalled = computed(() => installedSpaceRows(
    spaces(), marketOrigins(), installedMarketSummaries().items,
    { keyword: keyword(), category: category(), sort: effectiveSort() },
  ));
  const visibleElsewhere = computed(() => spacesElsewhere().filter(app =>
    matchesCategory(app.category) && (!keyword() || matchesText([app.name, app.description]))));
  const resetFilters = () => {
    query.set("");
    category.set("all");
  };
  const marketFromInstalled = () => spacesView() === "library" && installedDetail()?.from === "library"
    && Boolean(marketDetailTarget());
  const detailedMarket = () => Boolean(marketDetailTarget())
    && (spacesView() === "market" || (spacesView() === "library" && (marketFromInstalled() || Boolean(marketFromAppCard()))));
  const detailedSpace = () => {
    const detail = installedDetail();
    if (!detail || (detail.from === "market" ? !detailedMarket() : spacesView() !== "library")) return;
    return spaceInCurrentCatalog(detail.appId);
  };
  const marketCovered = () => Boolean(openSpace() || (installedDetail()?.from === "market" && detailedSpace()));
  const installedCovered = () => Boolean(openSpace() || marketFromInstalled());
  let manageButton: ViewRef | null = null;
  let listingButton: ViewRef | null = null;
  let catalogOffset = 0;
  let restoreOffset: number | null = null;
  let appliedOffset: number | null = null;
  let viewport: ScrollRef | null = null;
  let viewportHeight = 0;
  let contentHeight = 0;
  let focusOnReturn: { view: SpacesView; key: string } | null = null;
  function stopRestoringCatalog() {
    restoreOffset = null;
    appliedOffset = null;
  }
  function restoreCatalog() {
    if (!viewport || restoreOffset === null || !viewportHeight || !contentHeight) return;
    const offset = Math.min(restoreOffset, Math.max(0, contentHeight - viewportHeight));
    if (offset === appliedOffset) return;
    appliedOffset = offset;
    viewport.scrollTo({ y: offset, animated: false });
    if (offset === 0) stopRestoringCatalog();
  }
  function rememberCatalogReturn(view: SpacesView, key: string | null) {
    focusOnReturn = key === null ? null : { view, key };
    restoreOffset = catalogOffset;
  }
  function restoreCardFocus(view: SpacesView, key: string, node: ViewRef | null) {
    if (!node || focusOnReturn?.view !== view || focusOnReturn.key !== key) return;
    focusOnReturn = null;
    queueMicrotask(() => node.focus());
  }
  function backFromInstalledDetails() {
    const detail = installedDetail();
    if (detail?.from === "market") queueMicrotask(() => manageButton?.focus());
    else rememberCatalogReturn("library", detail?.appId ?? null);
    closeSpaceInspector();
    installedDetail.set(null);
  }
  function backToMarket() {
    if (marketFromInstalled()) queueMicrotask(() => listingButton?.focus());
    else if (marketFromAppCard()) rememberCatalogReturn("library", marketFromAppCard());
    else rememberCatalogReturn("market", marketDetailSlug());
    marketFromAppCard.set(null);
    closeMarketListing();
  }
  let catalogDevice = deviceContext();
  let catalogConnection = backendConnection();
  effect(() => {
    const device = deviceContext();
    const connection = backendConnection();
    if (device === catalogDevice && connection === catalogConnection) return;
    catalogDevice = device;
    catalogConnection = connection;
    catalogOffset = 0;
    stopRestoringCatalog();
    focusOnReturn = null;
    installedDetail.set(null);
    marketFromAppCard.set(null);
    closeMarketListing();
    resetFilters();
    installedSort.set("downloads");
  });
  effect(() => {
    const detail = installedDetail();
    if (detail && !spacesBusy() && hasCurrentSpaceCatalog() && !spaceInCurrentCatalog(detail.appId)) {
      if (detail.from === "market") untracked(() => clearDeletedMarketInstall(detail.appId));
      else if (marketFromInstalled()) closeMarketListing();
      installedDetail.set(null);
    }
  });
  const refreshControls = () => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <If when={spacesBusy() && !spacesInitialLoad()}>
        <Spinner size={14} />
      </If>
      <IconButton
        icon="refresh"
        size="md"
        accessibilityLabel="spaces-refresh"
        tooltip={tr("spaces.refreshTooltip")}
        disabled={spacesBusy()}
        style={
          compactLayout()
            ? {
                width: layout.touchTarget,
                height: layout.touchTarget,
                minWidth: layout.touchTarget,
                minHeight: layout.touchTarget,
              }
            : undefined
        }
        onPress={() => refreshCurrentView()}
      />
    </View>
  );
  const spaceViewTabs = () => (
    <Scroll smoothWheel horizontal scrollbar={false} style={{ maxWidth: "100%", minWidth: 0 }}>
      <SegmentedTabs size="sm" options={viewTabs()} value={spacesView()} onChange={next => spacesView.set(next)} />
    </Scroll>
  );
  effect(() => {
    // The device the Library looks at (fleet) or the driven peer (older backends).
    void deviceContext();
    void backendConnection();
    untracked(() => {
      void loadSpaces();
      void loadMarketOrigins();
      void loadAccountCatalog();
    });
  });
  // Each view reads its own host state when it is shown (and again when the
  // driven device changes), so a hidden view costs nothing.
  effect(() => {
    void deviceContext();
    void backendConnection();
    const view = spacesView();
    untracked(() => {
      if (installedDetail()?.from !== view) installedDetail.set(null);
      if (view === "market") enterMarket();
      else {
        marketFromAppCard.set(null);
        closeMarketListing();
        if (view === "submissions") void loadSubmissions();
      }
    });
  });
  effect(() => {
    if (spacesView() !== "library") return;
    const ids = installedListingIds();
    void installedMarketSummariesSupported();
    untracked(() => void loadInstalledMarketSummaries(ids));
  });
  const unsubscribe = subscribeSpaceEvents();
  cleanup(() => {
    unsubscribe();
    closeMarketListing();
  });
  // wave22-p4: a Space page belongs to the device it opened on.
  let openedFor = deviceContext();
  effect(() => {
    const device = deviceContext();
    if (device !== openedFor) {
      openedFor = device;
      if (openSpace()?.deviceId && openSpace()?.deviceId !== device) closeSpacePage();
    }
  });

  return (
    <View
      onLayout={trackStudioWidth}
      style={{ flex: 1, minWidth: 0, minHeight: 0, flexDirection: "column", backgroundColor: palette().canvas }}
    >
      <If when={openSpace()}>
        <SpacePage permissionLabel={localizePermission} />
      </If>
      <If when={detailedSpace()}>
        {app => <View accessibilityElementsHidden={installedCovered()}
          style={{ flex: 1, minHeight: 0, display: installedCovered() ? "none" : "flex" }}>
          <InstalledSpaceDetails space={app} onBack={backFromInstalledDetails}
            backText={installedDetail()?.from === "market" ? tr("market.backToListing") : undefined}
            listingButtonRef={node => { listingButton = node; }}
            onViewListing={installedDetail()?.from === "library" ? listingId => {
              if (spaceInCurrentCatalog(app().id)) void openMarketListing({ listingId });
            } : undefined} />
        </View>}
      </If>
      <If when={detailedMarket()}>
        <View accessibilityElementsHidden={marketCovered()}
          style={{ flex: 1, minHeight: 0, display: marketCovered() ? "none" : "flex" }}>
          <SpaceDetailsFrame accessibilityLabel="market-listing" backLabel="market-close"
            backText={marketFromInstalled() ? tr("market.backToInstalled") : undefined} onBack={backToMarket}>
            <MarketListingDetails manageButtonRef={node => { manageButton = node; }}
              onManage={appId => {
                if (!spaceInCurrentCatalog(appId) || !detailedMarket()) return;
                if (marketFromInstalled()) backToMarket();
                else installedDetail.set({ appId, from: "market" });
              }} />
          </SpaceDetailsFrame>
        </View>
      </If>
      <If when={!openSpace() && !detailedSpace() && !detailedMarket()}>
      <Scroll testID="spaces-catalog-scroll" smoothWheel
        ref={node => {
          viewport = node;
          if (!node) { viewportHeight = 0; contentHeight = 0; }
        }}
        onLayout={event => { viewportHeight = event.bounds.size.height; queueMicrotask(restoreCatalog); }}
        onWheel={stopRestoringCatalog} onTouchStart={stopRestoringCatalog}
        onKeyDown={stopRestoringCatalog} onScrollDragStart={stopRestoringCatalog}
        onScroll={event => {
          if (appliedOffset !== null && Math.abs(event.offset.y - appliedOffset) < 1) stopRestoringCatalog();
          if (!installedDetail() && !marketDetailTarget() && restoreOffset === null) catalogOffset = Math.max(0, event.offset.y);
        }}
        style={{ flex: 1, minHeight: 0 }}>
        <View onLayout={event => { contentHeight = event.bounds.size.height; queueMicrotask(restoreCatalog); }}>
        <If
          when={props.embedded}
          else={
            <StudioHeader
              title={tr("spaces.title")}
              subtitle={tr("spaces.subtitle")}
              actions={refreshControls()}
              extra={spaceViewTabs()}
            />
          }
        >
          <LibraryToolbar accessibilityLabel="spaces-toolbar" leading={spaceViewTabs()} primary={refreshControls()} />
        </If>
        <StudioBody style={props.embedded ? libraryBodyStyle() : undefined}>
          <If when={spacesError()}>
            {err => <InlineBanner tone="danger" message={localizeHostError(err())} />}
          </If>
          <If when={spacesNotice() && !spacesError()}>
            <InlineBanner
              tone="neutral"
              icon="check-circle"
              message={localizeHostError(spacesNotice() ?? "")}
              onDismiss={() => spacesNotice.set("")}
            />
          </If>

          <If when={spacesView() === "market"}>
            <MiniAppMarketView onCardRef={(slug, node) => restoreCardFocus("market", slug, node)} />
          </If>
          <If when={spacesView() === "submissions"}>
            <MiniAppSubmissionsView />
          </If>
          {/* wave22-p3 cards, under Library › Spaces › Cards (wave22-p4). */}
          <If when={spacesView() === "cards"}>
            <CardsSection deviceId={cardsDeviceForLibrary()} />
          </If>
          <If when={spacesView() === "library"}>
          <SpaceCatalogToolbar scope="spaces" query={query()} placeholder={tr("spaces.searchPlaceholder")}
            onQueryChange={query.set} category={category()} onCategoryChange={category.set}
            sort={{ value: effectiveSort(), onChange: installedSort.set, rankingsAvailable: rankingsAvailable() }} />

          <If when={installedMarketSummaries().status === "unsupported"}>
            <InlineBanner tone="neutral" message={tr("market.installedRankingsOutdated")} />
          </If>
          <If when={installedMarketSummaries().status === "unavailable"}>
            <InlineBanner tone="neutral" message={tr("market.installedRankingsUnavailable")} actionLabel={tr("common.retry")}
              onAction={() => void loadInstalledMarketSummaries(installedListingIds())} />
          </If>

          <StudioSection
            title={tr("spaces.polish.installedSection")}
            accessibilityLabel="spaces-installed-section"
            trailing={
              <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm }}>
                <Text
                  style={{
                    color: palette().textSecondary,
                    fontSize: textSize(13),
                    fontVariant: ["tabular-nums"],
                    lineHeight: textLineHeight(13, 1.35),
                  }}
                >
                  {installedSummary()}
                </Text>
                <Button
                  label={tr("market.import.open")}
                  variant="ghost"
                  size={compactLayout() ? "md" : "sm"}
                  leadingIcon="upload"
                  accessibilityLabel="spaces-import-package"
                  style={compactLayout() ? { minHeight: layout.touchTarget } : undefined}
                  onPress={() => openPackageImport()}
                />
              </View>
            }
          >
            <If when={spaces().length === 0 && spacesBusy() && spacesInitialLoad()}>
              <GallerySkeleton count={4} />
            </If>
            <If when={!hasFilters() && spaces().length === 0 && !spacesError() && !(spacesBusy() && spacesInitialLoad())}>
              <StudioEmpty
                icon="layout-grid"
                message={tr("spaces.emptyTitle")}
                detail={tr("spaces.emptySubtitle")}
              />
            </If>
            <If when={hasFilters() && !spacesBusy() && !accountCatalogLoading() && !spacesError()
              && installedMarketSummaries().status !== "loading"
              && visibleInstalled().length === 0 && visibleElsewhere().length === 0}>
              <StudioEmpty
                accessibilityLabel="spaces-no-matches"
                icon="search"
                message={tr("market.emptyTitle")}
                detail={tr("market.emptyFiltered")}
                action={<Button label={tr("common.resetFilter")} variant="secondary" size="md"
                  accessibilityLabel="spaces-reset-filters"
                  style={compactLayout() ? { minHeight: layout.touchTarget } : undefined}
                  onPress={resetFilters} />}
              />
            </If>
            <If when={visibleInstalled().length > 0}>
              <GalleryGrid minColumn={props.embedded ? SPACE_GALLERY_MIN_COLUMN : undefined} gap={space.md}>
                <Each of={visibleInstalled()} key={item => item.app.id}>
                  {item => <SpaceCard space={() => item().app} updateAvailable={item().updateAvailable}
                    onManage={item().listing ? () => {
                      if (spaceInCurrentCatalog(item().app.id)) installedDetail.set({ appId: item().app.id, from: "library" });
                    } : undefined}
                    onDetails={() => {
                      const { app, listing } = item();
                      if (!spaceInCurrentCatalog(app.id)) return;
                      if (listing) {
                        marketFromAppCard.set(app.id);
                        void openMarketListing({ listingId: listing.listingId });
                      } else installedDetail.set({ appId: app.id, from: "library" });
                    }}
                    onRef={node => restoreCardFocus("library", item().app.id, node)} />}
                </Each>
              </GalleryGrid>
            </If>
          </StudioSection>

          {/* wave22-p4: the account's Spaces that live on other devices. */}
          <If when={visibleElsewhere().length > 0}>
            <StudioSection title={tr("spaces.p4.elsewhereTitle")} accessibilityLabel="spaces-elsewhere-section">
              <ElsewhereList apps={visibleElsewhere()} onOpen={openElsewhereSpace} />
            </StudioSection>
          </If>
          {/* wave22-p4: Spaces open inside the app everywhere; only "Open in window" is desktop-only. */}
          </If>
        </StudioBody>
        </View>
      </Scroll>
      </If>

      <SpaceInspectorModal />
      <PackageImportModal />
    </View>
  );
}
