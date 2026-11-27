// Frameless full-viewport image preview lightbox + shared ImageViewerStage /
// ImageViewerToolbar reused by both the session image lightbox and FilesScene
// image preview. The file viewer keeps its zoom and rotation when expanded,
// and exports the original workspace bytes through the controller shell.

import { Canvas, Clipboard, Image, Scroll, Text, View, cleanup, computed, effect, signal, type ViewRef } from "nsh";
import { Dialog } from "nsh/base";
import { isAvailable as desktopMenusAvailable, Menu } from "nsh/desktop";
import { localBinaryFileExport } from "../bridge";
import { formatBytes, formatCount } from "../format";
import { localizeHostError, tr } from "../i18n";
import { errorMessageOf } from "../shared/errorUtils";
import { elevationShadow, palette, radii, space, textLineHeight, textSize, textStyle } from "../theme";
import { Icon } from "./icons";
import { MOTION_DURATION, modalEnterMotion, pressTransition, tactileActiveStyle } from "./motion";
import { pushToast, registerEscapeDismiss } from "./overlays";
import { IconButton, TooltipBubble, focusRingStyle } from "./primitives";
import { Toolbar, ToolbarSeparator } from "./Toolbar";

export interface LightboxImage {
  src: string;
  title?: string;
  fileName?: string;
  view?: ImageViewState;
  onClose?: () => void;
}

export type ImageZoomState = "fit" | number;
type ImageRotation = 0 | 90 | 180 | 270;

export function createImageViewState() {
  return { zoom: signal<ImageZoomState>("fit"), rotation: signal<ImageRotation>(0) };
}

type ImageViewState = ReturnType<typeof createImageViewState>;

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5.0;

export const lightboxImage = signal<LightboxImage | null>(null);

export function openImageLightbox(image: LightboxImage): void {
  const src = image.src.trim();
  if (!src) return;
  lightboxImage.set({ ...image, src, title: image.title?.trim() || undefined });
}

export function closeImageLightbox(): void {
  const image = lightboxImage();
  lightboxImage.set(null);
  image?.onClose?.();
}

/** Computes the fit scale (<= 1 for small images, proportional shrink for large ones). */
export function computeImageFitScale(
  natural: { width: number; height: number } | null,
  stage: { width: number; height: number } | null,
): number {
  if (!natural || natural.width <= 0 || natural.height <= 0) return 1;
  if (!stage || stage.width <= 0 || stage.height <= 0) return 1;
  return Math.min(1, stage.width / natural.width, stage.height / natural.height);
}

/** Steps zoom cleanly by 25% increments (`25%`, `50%`, `75%`, `100%`, `125%`, ...). */
export function stepImageZoom(current: ImageZoomState, direction: 1 | -1, fitScale: number): number {
  const base = current === "fit" ? fitScale : current;
  const raw =
    direction > 0
      ? (Math.floor(base / ZOOM_STEP + 1e-6) + 1) * ZOOM_STEP
      : (Math.ceil(base / ZOOM_STEP - 1e-6) - 1) * ZOOM_STEP;
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, raw));
  return Math.round(clamped * 100) / 100;
}

interface ImageViewerToolbarProps {
  zoom: () => ImageZoomState;
  effectiveScale: () => number;
  src: () => string;
  onZoomChange: (next: ImageZoomState) => void;
  showClose?: boolean;
  onClose?: () => void;
  onRotate: () => void;
  fileName?: string;
  canExport: boolean;
  onExpand?: () => void;
  captureExpandButton: (node: ViewRef) => void;
}

function imageExportName(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim().replace(/[. ]+$/, "");
  if (!cleaned) return "image";
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned) ? `_${cleaned}` : cleaned;
}

function ImageViewerToolbar(props: ImageViewerToolbarProps) {
  const copied = signal(false);
  const exporting = signal(false);
  const fileExport = localBinaryFileExport();
  const share = fileExport?.kind === "share";
  const exportLabel = () => tr(share ? "files.shareImage" : "files.downloadImage");
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;
  cleanup(() => {
    if (copiedTimer) {
      clearTimeout(copiedTimer);
      copiedTimer = null;
    }
  });

  const copyImage = async () => {
    const src = props.src();
    if (!src) return;
    try {
      await Clipboard.writeImage(src);
      copied.set(true);
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => {
        copiedTimer = null;
        copied.set(false);
      }, 1500);
      pushToast(tr("sessions.imageCopied"), "success");
    } catch {
      pushToast(tr("sessions.imageCopyFailed"), "error");
    }
  };

  async function exportImage() {
    if (!fileExport || !props.fileName || !props.canExport || exporting()) return;
    const src = props.src();
    const separator = src.indexOf(",");
    const header = /^data:(image\/[a-z\d.+-]+);base64$/i.exec(src.slice(0, separator));
    if (!header || separator === src.length - 1) return;
    exporting.set(true);
    try {
      const outcome = await fileExport.run({
        title: exportLabel(), fileName: imageExportName(props.fileName),
        mimeType: header[1], base64: src.slice(separator + 1),
      });
      if (outcome === "saved") pushToast(tr("common.saved"), "success");
      else if (outcome === "started") pushToast(tr("files.imageDownloadStarted"), "info");
    } catch (error) {
      pushToast(errorMessageOf(error).includes("IMAGE_SHARE_TOO_LARGE")
        ? tr("files.imageShareTooLarge") : localizeHostError(error), "error");
    } finally {
      exporting.set(false);
    }
  }

  const pct = () => `${Math.max(1, Math.round(props.effectiveScale() * 100))}%`;
  const atMin = () => props.effectiveScale() <= ZOOM_MIN + 1e-4;
  const atMax = () => props.effectiveScale() >= ZOOM_MAX - 1e-4;

  return (
    <View
      accessibilityLabel="image-viewer-toolbar"
      onPress={() => undefined}
      style={[{
        flexDirection: "row",
        alignItems: "center",
        flexShrink: 0,
        gap: 2,
      }, props.fileName ? undefined : {
        paddingHorizontal: 6,
        paddingVertical: 4,
        borderRadius: radii.pill,
        borderWidth: 1,
        borderColor: palette().border,
        backgroundColor: palette().glassOverlayBg,
        backdropFilter: "blur(16px) saturate(1.2)",
        boxShadow: `${elevationShadow(2)}, ${palette().innerHighlight}`,
      }]}
    >
      <IconButton
        icon="minus"
        size="xs"
        iconSize={13}
        disabled={atMin()}
        tooltip={tr("files.zoomOut")}
        accessibilityLabel="image-zoom-out"
        style={{ borderRadius: radii.pill }}
        onPress={() => props.onZoomChange(stepImageZoom(props.zoom(), -1, props.effectiveScale()))}
      />
      <View
        role="button"
        accessibilityLabel="image-zoom-percent"
        tooltip={<TooltipBubble text={tr("files.zoomFit")} />}
        onPress={() => props.onZoomChange("fit")}
        style={{
          minWidth: 46,
          height: 24,
          paddingHorizontal: space.xs,
          borderRadius: radii.pill,
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          userSelect: "none",
          ...pressTransition(MOTION_DURATION.fast),
        }}
        hoverStyle={{ backgroundColor: palette().panelHover }}
        activeStyle={tactileActiveStyle(0.96)}
        focusVisibleStyle={focusRingStyle()}
      >
        <Text
          style={{
            ...textStyle("caption", { color: palette().text, tabular: true }),
            fontWeight: "500",
          }}
        >
          {pct()}
        </Text>
      </View>
      <IconButton
        icon="plus"
        size="xs"
        iconSize={13}
        disabled={atMax()}
        tooltip={tr("files.zoomIn")}
        accessibilityLabel="image-zoom-in"
        style={{ borderRadius: radii.pill }}
        onPress={() => props.onZoomChange(stepImageZoom(props.zoom(), 1, props.effectiveScale()))}
      />

      <ToolbarSeparator />

      <View
        role="button"
        accessibilityLabel={props.zoom() === "fit" ? "image-zoom-actual" : "image-zoom-fit"}
        onPress={() => props.onZoomChange(props.zoom() === "fit" ? 1 : "fit")}
        style={{
          height: 24,
          paddingHorizontal: space.sm,
          borderRadius: radii.pill,
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          userSelect: "none",
          ...pressTransition(MOTION_DURATION.fast),
        }}
        hoverStyle={{ backgroundColor: palette().panelHover }}
        activeStyle={tactileActiveStyle(0.96)}
        focusVisibleStyle={focusRingStyle()}
      >
        <Text
          style={{
            ...textStyle("caption", { color: palette().textSecondary, tabular: true }),
            fontWeight: "500",
          }}
        >
          {props.zoom() === "fit" ? "1:1" : tr("files.zoomFit")}
        </Text>
      </View>

      <ToolbarSeparator />

      <IconButton icon="rotate-cw" size="xs" tooltip={tr("files.rotateImage")}
        accessibilityLabel="image-rotate-clockwise" disabled={!props.canExport} onPress={props.onRotate} />
      <IconButton
        icon={copied() ? "check" : "copy"}
        size="xs"
        iconSize={13}
        accessibilityLabel="image-lightbox-copy"
        tooltip={tr("sessions.copyImage")}
        style={{ borderRadius: radii.pill }}
        onPress={() => void copyImage()}
      />

      <If when={Boolean(props.fileName && fileExport)}>
        <IconButton icon={share ? "upload" : "download"} size="xs" tooltip={exportLabel()}
          accessibilityLabel={share ? "image-share" : "image-download"} disabled={!props.canExport || exporting()}
          onPress={() => void exportImage()} />
      </If>
      <If when={Boolean(props.onExpand)}>
        <IconButton icon="maximize" size="xs" tooltip={tr("files.openImageFullscreen")}
          accessibilityLabel="image-fullscreen" disabled={!props.canExport}
          buttonRef={props.captureExpandButton} onPress={() => props.onExpand?.()} />
      </If>
      <If when={Boolean(props.showClose && props.onClose)}>
        <ToolbarSeparator />
        <IconButton
          icon={props.fileName ? "minimize" : "close"}
          size="xs"
          iconSize={13}
          accessibilityLabel="image-lightbox-close"
          tooltip={tr(props.fileName ? "files.exitImageFullscreen" : "common.close")}
          style={{ borderRadius: radii.pill }}
          onPress={() => props.onClose?.()}
        />
      </If>
    </View>
  );
}

export interface ImageViewerSurfaceProps {
  src: () => string;
  imageAccessibilityLabel?: () => string;
  view: ImageViewState;
  fileName?: string;
  showClose?: boolean;
  onClose?: () => void;
  onBackdropPress?: () => void;
  onError?: (message: string) => void;
  padding?: number;
}

/** Files docks the controls above the image. Session previews use the floating toolbar. */
export function ImageViewerSurface(props: ImageViewerSurfaceProps) {
  const naturalSize = signal<{ width: number; height: number } | null>(null);
  const stageSize = signal<{ width: number; height: number } | null>(null);
  const loadFailed = signal(false);
  let expandButton: ViewRef | null = null;
  let mounted = true;
  cleanup(() => { mounted = false; });

  effect(() => {
    props.src();
    naturalSize.set(null);
    loadFailed.set(false);
  });

  const isSideways = () => props.view.rotation() === 90 || props.view.rotation() === 270;
  const imageBounds = (size: { width: number; height: number } | null) =>
    size && isSideways() ? { width: size.height, height: size.width } : size;
  const fitScale = computed(() => computeImageFitScale(imageBounds(naturalSize()), stageSize()));
  const effectiveScale = computed(() => {
    const z = props.view.zoom();
    return z === "fit" ? fitScale() : z;
  });
  const displayDimensions = computed<{ width: number; height: number } | null>(() => {
    const nat = naturalSize();
    if (!nat || nat.width <= 0 || nat.height <= 0) return null;
    const scale = effectiveScale();
    return {
      width: Math.max(1, Math.round(nat.width * scale)),
      height: Math.max(1, Math.round(nat.height * scale)),
    };
  });
  const displayBounds = computed(() => imageBounds(displayDimensions()));
  const fileSize = computed(() => {
    const source = props.src();
    const comma = source.indexOf(",");
    if (!source.startsWith("data:image/") || comma < 0) return 0;
    const padding = source.endsWith("==") ? 2 : source.endsWith("=") ? 1 : 0;
    return Math.floor((source.length - comma - 1) * 3 / 4) - padding;
  });

  const copyViaContextMenu = async () => {
    const src = props.src();
    if (!src) return;
    try {
      await Clipboard.writeImage(src);
      pushToast(tr("sessions.imageCopied"), "success");
    } catch {
      pushToast(tr("sessions.imageCopyFailed"), "error");
    }
  };

  const pad = props.padding ?? space.lg;
  const expandedElsewhere = () => !props.showClose && lightboxImage()?.view === props.view;
  const toolbar = () => <ImageViewerToolbar
    zoom={props.view.zoom}
    effectiveScale={effectiveScale}
    src={props.src}
    onZoomChange={props.view.zoom.set}
    onRotate={() => props.view.rotation.set(((props.view.rotation() + 90) % 360) as ImageRotation)}
    fileName={props.fileName}
    canExport={!loadFailed() && !!props.src()}
    onExpand={props.fileName && !props.showClose ? () => openImageLightbox({
      src: props.src(), title: props.fileName, fileName: props.fileName, view: props.view,
      onClose: () => requestAnimationFrame(() => requestAnimationFrame(() => {
        if (mounted && !lightboxImage()) expandButton?.focus();
      })),
    }) : undefined}
    captureExpandButton={node => { expandButton = node; }}
    showClose={props.showClose}
    onClose={props.onClose}
  />;

  return (
    <View style={{ flex: 1, width: "100%", minWidth: 0, minHeight: 0 }}>
      <If when={Boolean(props.fileName)}>
        <View accessibilityElementsHidden={expandedElsewhere()} style={{ pointerEvents: expandedElsewhere() ? "none" : "auto" }}>
          <Toolbar size="sm" leading={<View style={{ flex: 1, minWidth: 0, flexDirection: "row",
            alignItems: "center", gap: space.sm }}>
            <Text style={{ ...textStyle("caption", { color: palette().text }),
              fontWeight: "600", flexShrink: 1, numberOfLines: 1, textOverflow: "ellipsis-middle" }}>{props.fileName}</Text>
            <If when={(stageSize()?.width ?? 0) >= 560 ? naturalSize() : null}>{size =>
              <Text style={{ ...textStyle("caption", { color: palette().textMuted, tabular: true }), flexShrink: 0 }}>
                {`${formatCount(size().width)} × ${formatCount(size().height)}`}
              </Text>}
            </If>
            <If when={(stageSize()?.width ?? 0) >= 560 && fileSize() > 0}>
              <Text style={{ ...textStyle("caption", { color: palette().textMuted, tabular: true }), flexShrink: 0 }}>
                {formatBytes(fileSize())}
              </Text>
            </If>
          </View>} trailing={toolbar()} />
        </View>
      </If>
    <View
      style={{
        flex: 1,
        width: "100%",
        minWidth: 0,
        minHeight: 0,
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: pad,
        gap: space.md,
      }}
    >
      <View
        accessibilityLabel="image-lightbox-stage"
        onPress={props.onBackdropPress}
        onLayout={event => {
          const w = Math.floor(event.bounds.size.width);
          const h = Math.floor(event.bounds.size.height);
          const prev = stageSize();
          if (w > 0 && h > 0 && (!prev || Math.abs(prev.width - w) > 1 || Math.abs(prev.height - h) > 1)) {
            stageSize.set({ width: w, height: h });
          }
        }}
        style={{
          flex: 1,
          width: "100%",
          minWidth: 0,
          minHeight: 0,
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        <If when={Boolean(props.fileName)}>
          <Canvas accessibilityElementsHidden
            style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0,
              pointerEvents: "none", backgroundColor: palette().canvas }}
            draw={(context, { width, height }) => {
              const cell = 10;
              context.fillStyle = palette().panelHover;
              context.beginPath();
              for (let y = 0, row = 0; y < height; y += cell, row += 1) {
                for (let x = (row % 2) * cell; x < width; x += cell * 2) {
                  context.rect(x, y, cell, cell);
                }
              }
              context.fill();
            }} />
        </If>
        <If
          when={!loadFailed()}
          else={
            <View style={{ alignItems: "center", gap: space.sm, padding: space.xl }}>
              <Icon name="image" size={28} color={palette().textMuted} />
              <Text style={{ color: palette().textMuted, fontSize: textSize(13), lineHeight: textLineHeight(13, 1.4) }}>
                {tr("sessions.imagePreviewFailed")}
              </Text>
            </View>
          }
        >
          <Scroll
            smoothWheel
            horizontal={false}
            scrollbar={props.view.zoom() !== "fit"}
            style={{ flex: 1, width: "100%", minHeight: 0 }}
            contentStyle={{ flexGrow: 1, alignItems: "center", justifyContent: "center" }}
          >
            <Scroll
              smoothWheel
              horizontal
              scrollbar={props.view.zoom() !== "fit"}
              style={{ flex: 1, minWidth: 0 }}
              contentStyle={{ flexGrow: 1, alignItems: "center", justifyContent: "center" }}
            >
              <View
                onPress={() => undefined}
                onContextMenu={event => {
                  // Desktops only: the toolbar's copy button is the same action elsewhere.
                  if (!desktopMenusAvailable) return;
                  void Menu.popup(
                    [{ label: tr("sessions.copyImage"), onSelect: () => void copyViaContextMenu() }],
                    event.pagePosition,
                  );
                }}
                style={{
                  width: displayBounds()?.width ?? stageSize()?.width ?? "100%",
                  height: displayBounds()?.height ?? stageSize()?.height ?? "100%",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Image
                  src={props.src()}
                  accessibilityLabel={props.imageAccessibilityLabel?.() ?? "image-lightbox-img"}
                  onLoad={event => {
                    loadFailed.set(false);
                    if (event.size.width > 0 && event.size.height > 0) {
                      naturalSize.set(event.size);
                    }
                  }}
                  onError={event => {
                    loadFailed.set(true);
                    props.onError?.(event.message);
                  }}
                  style={{
                    width: displayDimensions()?.width ?? "100%",
                    height: displayDimensions()?.height ?? "100%",
                    objectFit: "contain",
                    borderRadius: radii.md,
                    transform: [{ rotate: `${props.view.rotation()}deg` }],
                  }}
                />
              </View>
            </Scroll>
          </Scroll>
        </If>
      </View>

      <If when={!props.fileName}>{toolbar()}</If>
    </View>
    </View>
  );
}

function ImageLightboxView(props: { image: LightboxImage }) {
  const view = props.image.view ?? createImageViewState();
  const motion = modalEnterMotion();
  cleanup(registerEscapeDismiss(() => closeImageLightbox()));

  return (
    <View
      role="dialog"
      accessibilityLabel="image-lightbox-dialog"
      style={[
        {
          flex: 1,
          width: "100%",
          height: "100%",
          flexDirection: "column",
        },
        motion.style,
      ]}
    >
      <ImageViewerSurface
        src={() => props.image.src}
        view={view}
        fileName={props.image.fileName}
        showClose={true}
        onClose={closeImageLightbox}
        onBackdropPress={closeImageLightbox}
        padding={space.xl}
      />
    </View>
  );
}

export function ImageLightboxHost() {
  return (
    <If when={lightboxImage()}>
      {image => (
        <Dialog
          open={true}
          animation="none"
          accessibilityLabel="image-lightbox-modal"
          closeOnBackdropPress={true}
          closeOnEscape={true}
          onOpenChange={event => {
            if (!event.open) closeImageLightbox();
          }}
          onCancel={closeImageLightbox}
          backdropStyle={{
            position: "absolute",
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
            backgroundColor: image().fileName ? palette().canvas : palette().scrimBg,
            ...(image().fileName ? {} : { backdropFilter: "blur(16px)" }),
          }}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
            alignItems: "stretch",
            justifyContent: "center",
            pointerEvents: "box-none",
          }}
        >
          <ImageLightboxView image={image()} />
        </Dialog>
      )}
    </If>
  );
}
