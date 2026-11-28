// Layer-4 overlay primitives: ModalDialog (Dialog), anchored DropdownMenu,
// SelectDropdown, ContextMenuOverlay, and Sonner-grade ToastHost.
// Built with origin-aware popover transitions, single-layer clean backdrops,
// flex-bounded scrolling, pause-on-hover toasts, and Break-UI overflow guards.

import {
  Overlay,
  Scroll,
  Text,
  View,
  cleanup,
  createMotion,
  effect,
  keymap,
  lifecycle,
  reduceMotion,
  safeArea,
  signal,
  untracked,
  type Align,
  type Bounds,
  type JSX,
  type KeyEvent,
  type Placement,
  type Point,
  type StyleProp,
  type ViewRef,
  type ViewStyle,
} from "nsh";
import { Dialog, Input } from "nsh/base";
import { designTokens } from "../generated/designTokens";
import { tr } from "../i18n";
import {
  compactLayout,
  controlHeight,
  designControlColors,
  elevationShadow,
  fontMono,
  inputFontSans,
  isLightAppearance,
  layout,
  palette,
  radii,
  space,
  textLineHeight,
  textSize,
  textStyle,
  touchSlop,
} from "../theme";
import { Icon, type IconName } from "./icons";
import {
  MOTION_DURATION,
  MOTION_EASE_STANDARD_BEZIER,
  drawerEnterMotion,
  enterMotion,
  modalEnterMotion,
  paintTransition,
  popoverEnterMotion,
  popoverOrigin,
  pressTransition,
  tactileActiveStyle,
} from "./motion";
import { ModalFormContext, type ModalFormBinding } from "./modalForm";
import { focusRingStyle } from "./primitives";

export type ModalSize = "sm" | "md" | "lg" | "xl";
const dialog = designTokens.metrics.dialog;
const menu = designTokens.metrics.menu;
const select = designTokens.metrics.select;

/** How long a first Escape over typed input waits for the second one. */
const ESCAPE_CONFIRM_MS = 2500;
/** Within this, a second Escape is the same key press heard by two listeners. */
const ESCAPE_SAME_PRESS_MS = 150;

// ---------------------------------------------------------------------------
// Menu-like surfaces and rows: one system for selects, menus, the command
// palette and picker lists.
//
// Hierarchy comes from layout, not colour: the leading glyph and any trailing
// mark sit on the title line (never centred between title and subtitle), the
// subtitle hangs under the title text in a smaller, quieter style, and the
// current value is a check plus weight rather than a tinted fill.
// ---------------------------------------------------------------------------

/** Line height of a list row's title; glyphs and trailing marks centre on it. */
export function listRowTitleLineHeight(): number {
  return textLineHeight(13, 1.4);
}

/** Hover / keyboard-active fill that stays visible on any surface, popovers included. */
export function listRowHoverBg(): string {
  return designControlColors()?.quietActionHover ?? palette().buttonSecondaryBg;
}

/** The floating surface of menus, selects and pickers. */
export function menuSurfaceStyle(): ViewStyle {
  return {
    borderRadius: menu.radius,
    borderCurve: "continuous",
    borderWidth: 1,
    borderColor: palette().border,
    backgroundColor: designControlColors()?.menuSurface ?? palette().popoverBg,
    boxShadow: designControlColors()?.menuShadow ?? palette().shadowOverlay,
  };
}

export interface ListRowContentProps {
  icon?: IconName;
  iconColor?: string;
  /** A custom glyph in place of `icon` (avatar, device glyph, state mark). */
  leading?: JSX.Element;
  title: string;
  titleColor?: string;
  titleWeight?: "400" | "500" | "600";
  titleOverflow?: "ellipsis" | "ellipsis-middle";
  subtitle?: string;
  subtitleOverflow?: "ellipsis" | "ellipsis-middle";
  subtitleLines?: number;
  /** Marks on the title line: a check, a shortcut, a ↵ hint. */
  trailing?: JSX.Element;
}

export function ListRowContent(props: ListRowContentProps) {
  const lineHeight = () => listRowTitleLineHeight();
  return (
    <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "flex-start", gap: menu.itemGap }}>
      <If when={Boolean(props.leading) || Boolean(props.icon)}>
        <View
          style={{
            height: lineHeight(),
            minWidth: 16,
            flexShrink: 0,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <If
            when={Boolean(props.leading)}
            else={
              <Icon
                name={(props.icon ?? "dot") as IconName}
                size={menu.itemIconSize}
                color={props.iconColor ?? palette().textMuted}
              />
            }
          >
            {props.leading}
          </If>
        </View>
      </If>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text
          style={{
            color: props.titleColor ?? palette().text,
            fontSize: textSize(13),
            fontWeight: props.titleWeight ?? "400",
            lineHeight: lineHeight(),
            numberOfLines: 1,
            textOverflow: props.titleOverflow ?? "ellipsis",
          }}
        >
          {props.title}
        </Text>
        <If when={props.subtitle ?? ""}>
          {sub => (
            <Text
              style={{
                color: palette().textMuted,
                fontSize: textSize(12),
                lineHeight: textLineHeight(12, 1.4),
                fontVariant: ["tabular-nums"],
                numberOfLines: props.subtitleLines ?? 1,
                textOverflow: props.subtitleOverflow ?? "ellipsis",
              }}
            >
              {sub()}
            </Text>
          )}
        </If>
      </View>
      <If when={Boolean(props.trailing)}>
        <View
          style={{
            height: lineHeight(),
            flexShrink: 0,
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm,
          }}
        >
          {props.trailing}
        </View>
      </If>
    </View>
  );
}

// LIFO Escape stack so Escape always dismisses only the topmost open modal,
// menu, drawer, or sheet — even when no `<Input>` inside it holds focus.
const escapeStack: Array<() => void> = [];
let unbindEscapeKey: (() => void) | null = null;

function syncEscapeBinding(): void {
  if (escapeStack.length > 0 && !unbindEscapeKey) {
    try {
      // "always": a field with the focus (a dialog focuses its first one) must not
      // keep Escape from the dialog or menu around it; no field uses the key itself.
      unbindEscapeKey = keymap.bind(
        "escape",
        () => {
          const top = escapeStack[escapeStack.length - 1];
          if (top) top();
        },
        { when: "always" },
      );
    } catch {
      unbindEscapeKey = null;
    }
  } else if (escapeStack.length === 0 && unbindEscapeKey) {
    const stop = unbindEscapeKey;
    unbindEscapeKey = null;
    stop();
  }
}

/**
 * Registers an Escape-key dismiss handler on the topmost overlay stack and
 * returns an unregister callback. Call inside a mounted overlay/sheet/drawer
 * and pair with `cleanup(...)`.
 */
export function registerEscapeDismiss(onDismiss: () => void): () => void {
  escapeStack.push(onDismiss);
  syncEscapeBinding();
  return () => {
    const idx = escapeStack.lastIndexOf(onDismiss);
    if (idx >= 0) escapeStack.splice(idx, 1);
    syncEscapeBinding();
  };
}

export interface ModalHeaderProps {
  title: string;
  subtitle?: string;
  leading?: JSX.Element;
  right?: JSX.Element;
  onClose?: () => void;
}

export function ModalHeader(props: ModalHeaderProps) {
  const hasSubtitle = () => Boolean(props.subtitle);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: hasSubtitle() ? "flex-start" : "center",
        flexShrink: 0,
        gap: space.md,
        paddingHorizontal: compactLayout() ? space.lg : dialog.headerPaddingInline,
        paddingTop: compactLayout() ? space.lg : dialog.headerPaddingTop,
        paddingBottom: compactLayout() ? space.md : dialog.headerPaddingBottom,
      }}
    >
      <If when={Boolean(props.leading)}>
        <View style={{ flexShrink: 0, marginLeft: -space.xs, marginTop: hasSubtitle() ? -2 : 0 }}>
          {props.leading}
        </View>
      </If>
      <View style={{ flex: 1, minWidth: 0, gap: space.hair }}>
        <Text style={textStyle("modalTitle")}>
          {props.title}
        </Text>
        <If when={props.subtitle ?? ""}>
          {subtitleText => (
            <Text style={textStyle("caption")}>
              {subtitleText()}
            </Text>
          )}
        </If>
      </View>
      <If when={Boolean(props.right)}>
        <View style={{ flexShrink: 0 }}>{props.right}</View>
      </If>
      <If when={Boolean(props.onClose)}>
        <View
          role="button"
          accessibilityLabel="modal-close"
          hitSlop={touchSlop(controlHeight.sm)}
          onPress={props.onClose}
          style={{
            width: controlHeight.sm,
            height: controlHeight.sm,
            marginTop: hasSubtitle() ? -2 : 0,
            marginRight: -space.xs,
            flexShrink: 0,
            borderRadius: radii.pill,
            borderCurve: "continuous",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            userSelect: "none",
            ...pressTransition(MOTION_DURATION.fast),
          }}
          hoverStyle={{ backgroundColor: palette().buttonSecondaryHover }}
          activeStyle={tactileActiveStyle(0.95, { backgroundColor: palette().buttonSecondaryPressed })}
          focusVisibleStyle={focusRingStyle()}
        >
          <Icon name="close" size={15} color={palette().textMuted} />
        </View>
      </If>
    </View>
  );
}

export interface ModalBodyProps {
  children?: JSX.Element;
  style?: StyleProp<ViewStyle>;
  hasHeader?: boolean;
}

export function ModalBody(props: ModalBodyProps) {
  return (
    <Scroll
      smoothWheel
      style={[{ flexShrink: 1, minHeight: 0 }, props.style]}
      contentStyle={{
        paddingHorizontal: compactLayout() ? space.lg : dialog.contentPadding,
        paddingTop: props.hasHeader ? 0 : compactLayout() ? space.lg : dialog.contentPadding,
        paddingBottom: compactLayout() ? space.lg : dialog.contentPadding,
        gap: space.lg,
      }}
    >
      {props.children}
    </Scroll>
  );
}

export interface ModalFooterProps {
  children?: JSX.Element;
}

export function ModalFooter(props: ModalFooterProps) {
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "flex-end",
        gap: space.sm,
        paddingHorizontal: compactLayout() ? space.lg : dialog.footerPaddingInline,
        paddingTop: dialog.footerPaddingTop,
        paddingBottom: compactLayout() ? space.md + safeArea().bottom : dialog.footerPaddingBottom,
        backgroundColor: "transparent",
      }}
    >
      {props.children}
    </View>
  );
}

export interface ModalDialogProps {
  open: boolean;
  title?: string;
  subtitle?: string;
  leading?: JSX.Element;
  size?: ModalSize;
  /** Keep the card at this height, capped by the viewport, while its body scrolls. */
  height?: number;
  footer?: JSX.Element;
  closeOnBackdropPress?: boolean;
  closeOnEscape?: boolean;
  /**
   * Keep the dialog on a click beside it even before anything is typed: a flow
   * that is waiting on something outside the app (a code in the mail, a browser
   * sign-in) would otherwise be lost to a stray click.
   */
  keepOpenOnBackdrop?: boolean;
  /** The dialog's primary action: Return in a single-line field without its own submit runs it. */
  onSubmit?: () => void;
  /**
   * What is typed here survives closing (kept in a store and shown again on the
   * next opening), so Escape closes at once even after an edit.
   */
  keepsInputOnClose?: boolean;
  accessibilityLabel?: string;
  onClose: () => void;
  children?: JSX.Element;
}

function ModalCard(props: ModalDialogProps & { onEscapeKey: () => void; escapeArmed: () => boolean }) {
  // Centered modal on desktop; bottom sheet with grab handle on phone (<720).
  const isSheet = compactLayout();
  const motion = isSheet ? drawerEnterMotion("bottom") : modalEnterMotion();
  if (props.closeOnEscape !== false) {
    cleanup(registerEscapeDismiss(() => props.onEscapeKey()));
  }
  return (
    <View
      role="dialog"
      accessibilityLabel={props.accessibilityLabel ?? props.title ?? "Dialog"}
      style={[
        {
          width: "100%",
          maxWidth: compactLayout() ? "100%" : dialog.width[props.size ?? "md"],
          height: props.height,
          maxHeight: compactLayout() ? "90%" : "100%",
          flexShrink: 1,
          borderTopLeftRadius: dialog.surfaceRadius,
          borderTopRightRadius: dialog.surfaceRadius,
          borderBottomLeftRadius: compactLayout() ? 0 : dialog.surfaceRadius,
          borderBottomRightRadius: compactLayout() ? 0 : dialog.surfaceRadius,
          borderCurve: "continuous",
          borderWidth: 1,
          borderBottomWidth: compactLayout() ? 0 : 1,
          borderColor: palette().borderSubtle,
          backgroundColor: palette().surfaceElevated,
          boxShadow: palette().shadowOverlay,
          overflow: "hidden",
          flexDirection: "column",
          paddingBottom: compactLayout() && !props.footer ? safeArea().bottom : 0,
          transformOrigin: compactLayout() ? "bottom center" : "center",
        },
        motion.style,
      ]}
    >
      <If when={compactLayout()}>
        <View style={{ alignItems: "center", paddingTop: space.sm, paddingBottom: space.xs, flexShrink: 0 }}>
          <View
            style={{
              width: 36,
              height: 4,
              borderRadius: radii.pill,
              backgroundColor: palette().borderStrong,
            }}
          />
        </View>
      </If>
      <If when={props.title ?? ""}>
        {titleText => (
          <ModalHeader
            title={titleText()}
            subtitle={props.subtitle}
            leading={props.leading}
            onClose={props.onClose}
          />
        )}
      </If>
      <ModalBody hasHeader={Boolean(props.title)} style={props.height === undefined ? undefined : { flexGrow: 1 }}>
        {props.children}
      </ModalBody>
      <If when={props.escapeArmed()}>
        <Text
          accessibilityLabel="modal-escape-again"
          style={{
            alignSelf: "center",
            paddingHorizontal: space.lg,
            paddingTop: space.sm,
            color: palette().textMuted,
            fontSize: textSize(12),
            lineHeight: textLineHeight(12, 1.4),
            textAlign: "center",
          }}
        >
          {tr("common.escapeAgainToDiscard")}
        </Text>
      </If>
      <If when={Boolean(props.footer)}>
        <ModalFooter>{props.footer}</ModalFooter>
      </If>
    </View>
  );
}

export function ModalDialog(props: ModalDialogProps) {
  // Once someone typed into the dialog, a click on the backdrop no longer closes it,
  // and Escape asks to be pressed a second time before it throws the input away.
  const edited = signal(false);
  /** A first Escape over typed input happened: the hint shows. */
  const escapeArmed = signal(false);
  /** The second Escape may close: set a moment after the first, so one key press heard twice never closes. */
  const escapeConfirmable = signal(false);
  let escapeArmTimer: ReturnType<typeof setTimeout> | null = null;
  let escapeReadyTimer: ReturnType<typeof setTimeout> | null = null;
  let autoFocusClaimed = false;
  const disarmEscape = () => {
    if (escapeArmTimer !== null) clearTimeout(escapeArmTimer);
    if (escapeReadyTimer !== null) clearTimeout(escapeReadyTimer);
    escapeArmTimer = null;
    escapeReadyTimer = null;
    if (escapeArmed()) escapeArmed.set(false);
    if (escapeConfirmable()) escapeConfirmable.set(false);
  };
  const armEscape = () => {
    disarmEscape();
    escapeArmed.set(true);
    escapeReadyTimer = setTimeout(() => {
      escapeReadyTimer = null;
      escapeConfirmable.set(true);
    }, ESCAPE_SAME_PRESS_MS);
    escapeArmTimer = setTimeout(() => {
      escapeArmTimer = null;
      disarmEscape();
    }, ESCAPE_CONFIRM_MS);
  };
  /** Input that closing would lose. */
  const guarded = (): boolean => edited() && !props.keepsInputOnClose;
  const escapeKey = (): void => {
    if (props.closeOnEscape === false) return;
    if (guarded() && !escapeConfirmable()) {
      if (!escapeArmed()) armEscape();
      return;
    }
    props.onClose();
  };
  /** A click beside the card: closes only a dialog with nothing typed and nothing under way. */
  const backdropPress = (): void => {
    if ((props.closeOnBackdropPress ?? true) && !edited() && !props.keepOpenOnBackdrop) props.onClose();
  };
  cleanup(disarmEscape);
  effect(() => {
    if (!props.open) {
      edited.set(false);
      autoFocusClaimed = false;
      disarmEscape();
    }
  });
  const form: ModalFormBinding = {
    markEdited: () => {
      if (!edited()) edited.set(true);
    },
    claimAutoFocus: () => {
      // On a phone the keyboard would cover the sheet the moment it opens.
      if (autoFocusClaimed || compactLayout()) return false;
      autoFocusClaimed = true;
      return true;
    },
    submit: () => props.onSubmit?.(),
    hasSubmit: () => Boolean(props.onSubmit),
  };
  return (
    <If when={props.open}>
      <Dialog
        open={props.open}
        animation="none"
        accessibilityLabel={props.accessibilityLabel ?? props.title ?? "Dialog"}
        // The backdrop is drawn below as a view of its own, so a click on it is told
        // apart from Escape: the dialog's own cancel then only hears Escape, back and swipe.
        closeOnBackdropPress={false}
        // Escape, back and swipe arrive as cancel attempts and are decided here, in one
        // place: the dialog never closes itself, so `open` and what shows cannot drift.
        closeOnEscape={false}
        onOpenChange={event => {
          if (!event.open) props.onClose();
        }}
        onCancel={escapeKey}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          padding: compactLayout() ? 0 : dialog.viewportGutter,
          alignItems: compactLayout() ? "stretch" : "center",
          justifyContent: compactLayout() ? "flex-end" : "center",
          pointerEvents: "box-none",
        }}
      >
        <View
          testID={`${props.accessibilityLabel ?? "dialog"}-backdrop`}
          focusable={false}
          onPress={backdropPress}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
            backgroundColor: palette().scrimBg,
            backdropFilter: dialog.backdropBlur,
          }}
        />
        <ModalFormContext.Provider value={form}>
          <ModalCard {...props} onEscapeKey={escapeKey} escapeArmed={escapeArmed} />
        </ModalFormContext.Provider>
      </Dialog>
    </If>
  );
}

export interface DropdownMenuItem {
  id: string;
  label: string;
  icon?: IconName;
  /** Optional second-line muted description below `label`. */
  hint?: string;
  /** Compact single-line right-aligned muted hint on the same row as `label`. */
  trailingHint?: string;
  shortcut?: string;
  active?: boolean;
  /** Allow several selections without reopening the menu. */
  keepOpenOnSelect?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** Renders a subtle hairline divider above this item. */
  separator?: boolean;
  /** Non-interactive section group header label (e.g. "Peer Devices", "SSH Hosts"). */
  header?: boolean;
  /** Transforms this menu row in-place into "Cancel | Confirm" instead of popping a modal. */
  confirmDelete?: boolean;
  /** Optional label for the in-place confirm button (defaults to `tr("common.confirm")`). */
  confirmLabel?: string;
  /** Optional accessibilityLabel for the in-place confirm button. */
  confirmAccessibilityLabel?: string;
  /** Optional accessibilityLabel for the in-place cancel button. */
  cancelAccessibilityLabel?: string;
  accessibilityLabel?: string;
  onSelect?: () => void;
}

export interface DropdownMenuProps {
  open: boolean;
  anchor: ViewRef | Point | Bounds | null | undefined;
  items: ReadonlyArray<DropdownMenuItem>;
  placement?: Placement;
  align?: Align;
  offset?: number;
  minWidth?: number;
  maxHeight?: number;
  onClose: () => void;
}

function MenuSurface(props: {
  items: ReadonlyArray<DropdownMenuItem>;
  placement: Placement;
  align: Align;
  minWidth: number;
  maxHeight: number;
  confirmingId: string | null;
  onConfirmingChange: (id: string | null) => void;
  onDismiss: () => void;
  onClose: () => void;
}) {
  const motion = popoverEnterMotion(props.placement, props.align, MOTION_DURATION.popover);
  const confirmingId = () => props.confirmingId;
  const enabledItems = () => props.items.filter(item => !item.header && !item.disabled && item.label);
  const activeId = signal<string | null>(enabledItems()[0]?.id ?? null);
  const activeDescendant = signal<ViewRef | null>(null);
  const rowRefs = new Map<string, ViewRef>();
  let menuRef: ViewRef | null = null;

  const highlight = (id: string | null, reveal = false) => {
    const node = id === null ? null : rowRefs.get(id) ?? null;
    activeId.set(id);
    activeDescendant.set(node);
    if (reveal) node?.reveal({ vertical: "nearest", animated: false });
  };
  effect(() => {
    const items = enabledItems();
    untracked(() => {
      if (!items.some(item => item.id === activeId())) highlight(items[0]?.id ?? null);
    });
  });

  cleanup(registerEscapeDismiss(() => props.onDismiss()));

  const activate = (item: DropdownMenuItem) => {
    if (item.disabled) return;
    highlight(item.id);
    if (item.confirmDelete) {
      props.onConfirmingChange(item.id);
      return;
    }
    if (!item.keepOpenOnSelect) props.onClose();
    item.onSelect?.();
  };

  const move = (step: 1 | -1) => {
    const items = enabledItems();
    if (!items.length) return;
    const current = items.findIndex(item => item.id === activeId());
    const index = current < 0 && step < 0 ? 0 : current;
    highlight(items[(index + step + items.length) % items.length].id, true);
  };
  const pick = () => {
    const item = enabledItems().find(item => item.id === activeId());
    if (item) activate(item);
  };
  effect(() => {
    if (confirmingId() !== null) return;
    menuRef?.focus();
    return keymap.bind({
      up: () => move(-1),
      down: () => move(1),
      home: () => highlight(enabledItems()[0]?.id ?? null, true),
      end: () => highlight(enabledItems().at(-1)?.id ?? null, true),
      enter: pick,
      space: pick,
    }, { when: "always", forFocus: true });
  });
  const typeahead = ({ key, modifiers, defaultPrevented }: KeyEvent) => {
    if (confirmingId() !== null || defaultPrevented || key.length !== 1 || !key.trim()
      || modifiers.alt || modifiers.control || modifiers.platform) return;
    const items = enabledItems();
    const after = items.findIndex(item => item.id === activeId()) + 1;
    const query = key.toLowerCase();
    const next = [...items.slice(after), ...items.slice(0, after)]
      .find(item => item.label.trimStart().toLowerCase().startsWith(query));
    if (next) highlight(next.id, true);
  };

  return (
    <View
      role="menu"
      ref={node => { menuRef = node; node?.focus(); }}
      focusable={true}
      accessibilityActiveDescendant={activeDescendant()}
      onKeyDown={typeahead}
      style={[
        {
          ...menuSurfaceStyle(),
          minWidth: props.minWidth,
          maxWidth: 340,
          maxHeight: props.maxHeight,
          padding: menu.padding,
          transformOrigin: popoverOrigin(props.placement, props.align),
        },
        motion.style,
      ]}
    >
      <Scroll
        smoothWheel
        style={{
          flexShrink: 1,
          minHeight: 0,
          maxHeight: Math.max(96, props.maxHeight - menu.padding * 2),
        }}
        scrollbar={true}
      >
        <View style={{ gap: menu.rowGap }}>
          <Each of={props.items} key={item => item.id}>
            {item => (
              <View style={{ gap: menu.rowGap }}>
                <If when={Boolean(item().separator)}>
                  <View
                    style={{
                      height: 1,
                      marginVertical: menu.sectionGap / 2,
                      marginHorizontal: menu.itemPadding,
                      backgroundColor: palette().borderSubtle,
                    }}
                  />
                </If>
                <If when={Boolean(item().header) && Boolean(item().label)}>
                  <View
                    style={{
                      minHeight: menu.headingHeight,
                      justifyContent: "center",
                      paddingHorizontal: menu.headingPadding,
                      pointerEvents: "none",
                    }}
                  >
                    <Text
                      style={{
                        color: palette().textMuted,
                        fontSize: textSize(12),
                        fontWeight: "500",
                        lineHeight: textLineHeight(12, 1.3),
                        numberOfLines: 1,
                        textOverflow: "ellipsis",
                      }}
                    >
                      {item().label}
                    </Text>
                  </View>
                </If>
                <If when={!item().header && Boolean(item().label)}>
                  <If
                    when={Boolean(item().confirmDelete && confirmingId() === item().id)}
                    else={
                      <View
                        ref={node => {
                          const id = item().id;
                          if (node) rowRefs.set(id, node);
                          else rowRefs.delete(id);
                          if (id === activeId()) activeDescendant.set(node);
                        }}
                        role="menuitem"
                        focusable={false}
                        disabled={item().disabled}
                        accessibilityLabel={item().accessibilityLabel ?? item().label}
                        accessibilityState={{
                          disabled: Boolean(item().disabled),
                          selected: Boolean(item().active),
                        }}
                        onMouseEnter={() => { if (!item().disabled && confirmingId() === null) highlight(item().id); }}
                        onPress={() => activate(item())}
                        style={{
                          minHeight: compactLayout() ? layout.touchTarget : menu.itemHeight,
                          flexDirection: "row",
                          alignItems: "center",
                          paddingHorizontal: menu.itemPadding,
                          paddingVertical: space.xs,
                          borderRadius: menu.itemRadius,
                          borderCurve: "continuous",
                          backgroundColor: confirmingId() === null && activeId() === item().id && !item().disabled
                            ? listRowHoverBg()
                            : "transparent",
                          cursor: item().disabled ? "not-allowed" : "pointer",
                          userSelect: "none",
                          ...pressTransition(MOTION_DURATION.fast),
                        }}
                        hoverStyle={{
                          backgroundColor: item().disabled
                            ? "transparent"
                            : item().danger
                              ? palette().dangerSoft
                              : listRowHoverBg(),
                        }}
                        activeStyle={tactileActiveStyle(0.985, {
                          backgroundColor: item().danger
                            ? palette().dangerHoverBg
                            : palette().buttonSecondaryHover,
                        })}
                        focusVisibleStyle={{ ...focusRingStyle(), outlineOffset: -1 }}
                        disabledStyle={{ opacity: 0.45 }}
                      >
                        <ListRowContent
                          icon={item().icon}
                          iconColor={item().danger ? palette().danger : palette().textSecondary}
                          title={item().label}
                          titleColor={item().danger ? palette().danger : palette().text}
                          titleWeight={item().active ? "500" : "400"}
                          subtitle={item().hint}
                          subtitleLines={2}
                          trailing={
                            item().trailingHint || item().shortcut || item().active ? (
                              <>
                                <If when={item().trailingHint ?? ""}>
                                  {trailingText => (
                                    <Text
                                      style={{
                                        maxWidth: 120,
                                        color: palette().textMuted,
                                        fontSize: textSize(12),
                                        lineHeight: textLineHeight(12, 1.3),
                                        numberOfLines: 1,
                                        textOverflow: "ellipsis",
                                      }}
                                    >
                                      {trailingText()}
                                    </Text>
                                  )}
                                </If>
                                <If when={item().shortcut ?? ""}>
                                  {shortcutText => (
                                    <Text
                                      style={{
                                        color: palette().textMuted,
                                        fontSize: textSize(12),
                                        fontVariant: ["tabular-nums"],
                                        lineHeight: textLineHeight(12, 1.3),
                                      }}
                                    >
                                      {shortcutText()}
                                    </Text>
                                  )}
                                </If>
                                <If when={Boolean(item().active)}>
                                  <Icon name="check" size={13} color={palette().accent} />
                                </If>
                              </>
                            ) : undefined
                          }
                        />
                      </View>
                    }
                  >
                    <View
                      accessibilityLabel={`${item().id}-inline-confirm`}
                      style={{
                        minHeight: compactLayout() ? layout.touchTarget : 30,
                        flexDirection: "row",
                        alignItems: "center",
                        gap: space.xs,
                        paddingHorizontal: space.xs,
                        paddingVertical: 3,
                        borderRadius: menu.itemRadius,
                        borderCurve: "continuous",
                        backgroundColor: palette().dangerSoft,
                      }}
                    >
                      <View
                        ref={node => node?.focus()}
                        role="button"
                        accessibilityLabel={item().cancelAccessibilityLabel ?? `${item().id}-cancel`}
                        onPress={() => props.onConfirmingChange(null)}
                        style={{
                          flex: 1,
                          height: compactLayout() ? 32 : 24,
                          borderRadius: radii.xs,
                          alignItems: "center",
                          justifyContent: "center",
                          cursor: "pointer",
                          userSelect: "none",
                          ...pressTransition(MOTION_DURATION.fast),
                        }}
                        hoverStyle={{ backgroundColor: palette().panelHover }}
                        activeStyle={tactileActiveStyle(0.96)}
                        focusVisibleStyle={{ ...focusRingStyle(), outlineOffset: -1 }}
                      >
                        <Text
                          style={{
                            color: palette().text,
                            fontSize: textSize(12),
                            lineHeight: textLineHeight(12, 1.25),
                            fontWeight: "500",
                          }}
                        >
                          {tr("common.cancel")}
                        </Text>
                      </View>
                      <View style={{ width: 1, height: 14, backgroundColor: palette().borderSubtle }} />
                      <View
                        role="button"
                        accessibilityLabel={item().confirmAccessibilityLabel ?? `${item().id}-confirm`}
                        onPress={() => {
                          props.onClose();
                          item().onSelect?.();
                        }}
                        style={{
                          flex: 1,
                          height: compactLayout() ? 32 : 24,
                          borderRadius: radii.xs,
                          borderWidth: 1,
                          borderColor: palette().dangerBorder,
                          alignItems: "center",
                          justifyContent: "center",
                          backgroundColor: palette().dangerHoverBg,
                          cursor: "pointer",
                          userSelect: "none",
                          ...pressTransition(MOTION_DURATION.fast),
                        }}
                        hoverStyle={{ borderColor: palette().danger }}
                        activeStyle={tactileActiveStyle(0.96)}
                        focusVisibleStyle={{ ...focusRingStyle(), outlineOffset: -1 }}
                      >
                        <Text
                          style={{
                            color: palette().danger,
                            fontSize: textSize(12),
                            lineHeight: textLineHeight(12, 1.25),
                            fontWeight: "600",
                          }}
                        >
                          {item().confirmLabel ?? tr("common.confirm")}
                        </Text>
                      </View>
                    </View>
                  </If>
                </If>
              </View>
            )}
          </Each>
        </View>
      </Scroll>
    </View>
  );
}

export function DropdownMenu(props: DropdownMenuProps) {
  const effectivePlacement = signal<Placement | null>(null);
  const availableHeight = signal<number | null>(null);
  const confirmingId = signal<string | null>(null);
  let lastInlineDismiss = -Infinity;
  const resetMenu = () => {
    effectivePlacement.set(null);
    availableHeight.set(null);
    confirmingId.set(null);
    lastInlineDismiss = -Infinity;
  };
  effect(() => { if (!props.open) resetMenu(); });
  const closeMenu = (restoreFocus: boolean) => {
    const anchor = props.anchor;
    props.onClose();
    resetMenu();
    if (restoreFocus && anchor && "focus" in anchor) anchor.focus();
  };
  const dismiss = () => {
    // A single Escape can reach both the keymap and the platform overlay.
    const now = Date.now();
    if (confirmingId() !== null) {
      lastInlineDismiss = now;
      confirmingId.set(null);
    } else if (now - lastInlineDismiss > ESCAPE_SAME_PRESS_MS) {
      closeMenu(true);
    }
  };

  const resolvedPlacement = (): Placement =>
    effectivePlacement() ?? props.placement ?? "bottom";

  const resolvedMaxHeight = (): number => {
    const requested = props.maxHeight ?? menu.maxHeight;
    const avail = availableHeight();
    if (avail && avail > 0) return Math.max(120, Math.min(requested, Math.floor(avail - 4)));
    return requested;
  };

  return (
    <If when={props.open}>
      <Overlay
        anchor={props.anchor ?? null}
        placement={props.placement ?? "bottom"}
        align={props.align ?? "start"}
        offset={props.offset ?? 6}
        margin={8}
        onPosition={pos => {
          effectivePlacement.set(pos.placement);
          availableHeight.set(pos.available.height);
        }}
        onPressOutside={() => closeMenu(false)}
        onCancel={dismiss}
      >
        <MenuSurface
          items={props.items}
          placement={resolvedPlacement()}
          align={props.align ?? "start"}
          minWidth={props.minWidth ?? menu.width}
          maxHeight={resolvedMaxHeight()}
          confirmingId={confirmingId()}
          onConfirmingChange={id => confirmingId.set(id)}
          onDismiss={dismiss}
          onClose={() => closeMenu(true)}
        />
      </Overlay>
    </If>
  );
}

export interface ContextMenuOverlayProps {
  open: boolean;
  position: Point | null;
  items: ReadonlyArray<DropdownMenuItem>;
  onClose: () => void;
}

export function ContextMenuOverlay(props: ContextMenuOverlayProps) {
  return <DropdownMenu open={props.open && props.position !== null} anchor={props.position} items={props.items}
    minWidth={190} maxHeight={400} offset={2} onClose={props.onClose} />;
}

export interface SelectDropdownOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
  icon?: IconName;
  disabled?: boolean;
  /** Draws a hairline above this option, e.g. to set an action ("New…") apart from values. */
  separator?: boolean;
  accessibilityLabel?: string;
}

export type SelectDropdownVariant = "default" | "ghost";
export type SelectDropdownSize = "sm" | "md" | "lg";

export interface SelectDropdownProps<T extends string = string> {
  options: ReadonlyArray<SelectDropdownOption<T>>;
  value: T | null | undefined;
  placeholder?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyLabel?: string;
  variant?: SelectDropdownVariant;
  size?: SelectDropdownSize;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityDescription?: string;
  testID?: string;
  minWidth?: number;
  maxWidth?: number;
  /** Stretch trigger horizontally to fill its parent container (e.g. a `ConfigRow` rail). */
  fullWidth?: boolean;
  placement?: Placement;
  align?: Align;
  style?: StyleProp<ViewStyle>;
  onChange: (value: T) => void;
}

function SelectPopoverSurface<T extends string>(props: {
  options: ReadonlyArray<SelectDropdownOption<T>>;
  value: T | null | undefined;
  placement: Placement;
  align: Align;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyLabel?: string;
  minWidth: number;
  maxHeight: number;
  query: string;
  onQueryChange: (q: string) => void;
  onSelect: (value: T) => void;
  onClose: () => void;
  listRef: (node: ViewRef | null) => void;
  onActiveOption: (node: ViewRef | null) => void;
}) {
  cleanup(registerEscapeDismiss(() => props.onClose()));
  const motion = popoverEnterMotion(props.placement, props.align, MOTION_DURATION.popover);

  const enabledOptions = () => props.options.filter(option => !option.disabled);
  const startValue = (options: readonly SelectDropdownOption<T>[]) =>
    options.find(option => option.value === props.value)?.value ?? options[0]?.value ?? null;
  const highlighted = signal<T | null>(startValue(enabledOptions()));
  const activeOption = signal<ViewRef | null>(null);
  const rowRefs = new Map<string, ViewRef>();
  const highlight = (value: T | null, reveal = false) => {
    highlighted.set(value);
    const node = value === null ? null : rowRefs.get(value) ?? null;
    activeOption.set(node);
    props.onActiveOption(node);
    if (reveal) node?.reveal({ vertical: "nearest", animated: false });
  };
  let lastQuery = props.query;
  effect(() => {
    const query = props.query;
    const options = enabledOptions();
    untracked(() => {
      // A new filter starts at its first match; the list it opened with keeps the current value.
      if (query !== lastQuery) {
        lastQuery = query;
        highlight(options[0]?.value ?? null);
      } else if (!options.some(option => option.value === highlighted())) {
        highlight(startValue(options));
      }
    });
  });

  const moveHighlight = (step: 1 | -1) => {
    const options = enabledOptions();
    if (!options.length) return;
    const current = options.findIndex(option => option.value === highlighted());
    const from = current < 0 && step < 0 ? 0 : current;
    const next = options[(from + step + options.length) % options.length];
    highlight(next.value, true);
  };
  const pickHighlighted = () => {
    const options = enabledOptions();
    const option = options.find(candidate => candidate.value === highlighted()) ?? options[0];
    if (option) props.onSelect(option.value);
  };
  try {
    cleanup(keymap.bind({ down: () => moveHighlight(1), up: () => moveHighlight(-1) }, { when: "always" }));
    if (props.searchable) {
      // Re-anchor tab navigation before the portalled input is removed.
      cleanup(keymap.bind({ tab: props.onClose, "shift+tab": props.onClose }, { when: "always", passThrough: true }));
    } else {
      cleanup(keymap.bind({
        home: () => highlight(enabledOptions()[0]?.value ?? null, true),
        end: () => highlight(enabledOptions().at(-1)?.value ?? null, true),
        enter: pickHighlighted,
        space: pickHighlighted,
      }, { forFocus: true, when: "always" }));
    }
  } catch {
    // Touch targets still offer the pointer and the filter.
  }

  const listMaxHeight = () =>
    Math.max(96, props.maxHeight - (props.searchable ? 56 : 12));

  return (
    <View
      style={[
        {
          ...menuSurfaceStyle(),
          minWidth: props.minWidth,
          maxWidth: Math.max(340, props.minWidth),
          maxHeight: props.maxHeight,
          padding: menu.padding,
          transformOrigin: popoverOrigin(props.placement, props.align),
          gap: 6,
        },
        motion.style,
      ]}
    >
      <If when={Boolean(props.searchable)}>
        <View
          style={{
            boxSizing: "border-box",
            height: compactLayout() ? 36 : controlHeight.sm,
            minHeight: compactLayout() ? 36 : controlHeight.sm,
            flexShrink: 0,
            flexDirection: "row",
            alignItems: "center",
            gap: space.chip,
            paddingHorizontal: space.sm,
            paddingVertical: 0,
            borderRadius: select.radius,
            borderCurve: "continuous",
            borderWidth: 1,
            borderColor: palette().border,
            backgroundColor: palette().inputBg,
            ...paintTransition(MOTION_DURATION.fast),
          }}
          focusWithinStyle={{
            borderColor: palette().fieldFocusBorder,
            boxShadow: `0 0 0 2px ${palette().accentSoft}`,
          }}
        >
          <Icon name="search" size={13} color={palette().textElevatedMuted} />
          <Input
            ref={node => node?.focus()}
            value={props.query}
            placeholder={props.searchPlaceholder ?? `${tr("common.filter")}…`}
            accessibilityLabel={props.searchPlaceholder ?? tr("common.filter")}
            accessibilityActiveDescendant={activeOption()}
            style={{
              flex: 1,
              minWidth: 0,
              height: "100%",
              minHeight: compactLayout() ? 34 : controlHeight.sm - 2,
              color: palette().text,
              placeholderColor: palette().textElevatedMuted,
              caretColor: palette().accent,
              fontFamily: inputFontSans(),
              fontSize: compactLayout() ? Math.max(16, textSize(14)) : textSize(12),
            }}
            onChange={e => props.onQueryChange(e.value)}
            onSubmit={() => pickHighlighted()}
            onKeyPress={e => {
              if (e.key === "Escape") props.onClose();
            }}
          />
        </View>
      </If>
      <Scroll
        ref={props.listRef}
        role="listbox"
        smoothWheel
        style={{ flexShrink: 1, minHeight: 0, maxHeight: listMaxHeight() }}
        scrollbar={true}
      >
        <View style={{ gap: menu.rowGap }}>
          <Each of={props.options} key={opt => opt.value}>
            {opt => (
              <View style={{ gap: menu.rowGap }}>
                <If when={Boolean(opt().separator)}>
                  <View
                    style={{
                      height: 1,
                      marginVertical: space.xs,
                      marginHorizontal: space.chip,
                      backgroundColor: palette().borderSubtle,
                    }}
                  />
                </If>
                <View
                  ref={el => {
                    if (el) rowRefs.set(opt().value, el);
                    else rowRefs.delete(opt().value);
                    if (opt().value === highlighted()) {
                      activeOption.set(el);
                      props.onActiveOption(el);
                    }
                  }}
                  onMouseEnter={() => {
                    if (!opt().disabled) highlight(opt().value);
                  }}
                  role="option"
                  focusable={false}
                  disabled={opt().disabled}
                  accessibilityLabel={opt().accessibilityLabel ?? opt().label}
                  accessibilityState={{
                    selected: opt().value === props.value,
                    disabled: Boolean(opt().disabled),
                  }}
                  onPress={() => {
                    if (opt().disabled) return;
                    props.onSelect(opt().value);
                  }}
                  style={{
                    minHeight: compactLayout() ? layout.touchTarget : menu.itemHeight,
                    flexDirection: "row",
                    alignItems: "center",
                    paddingHorizontal: menu.itemPadding,
                    paddingVertical: space.xs,
                    borderRadius: menu.itemRadius,
                    borderCurve: "continuous",
                    backgroundColor: highlighted() === opt().value ? listRowHoverBg() : "transparent",
                    cursor: opt().disabled ? "not-allowed" : "pointer",
                    userSelect: "none",
                    ...pressTransition(MOTION_DURATION.fast),
                  }}
                  hoverStyle={{
                    backgroundColor: opt().disabled ? "transparent" : listRowHoverBg(),
                  }}
                  activeStyle={tactileActiveStyle(0.985, {
                    backgroundColor: palette().buttonSecondaryHover,
                  })}
                  focusVisibleStyle={{ ...focusRingStyle(), outlineOffset: -1 }}
                  disabledStyle={{ opacity: 0.45 }}
                >
                  <ListRowContent
                    icon={opt().icon}
                    iconColor={palette().textSecondary}
                    title={opt().label}
                    titleWeight={opt().value === props.value ? "500" : "400"}
                    subtitle={opt().description}
                    trailing={
                      opt().value === props.value ? (
                        <Icon name="check" size={13} color={palette().accent} />
                      ) : undefined
                    }
                  />
                </View>
              </View>
            )}
          </Each>
          <If when={props.options.length === 0}>
            <View style={{ alignItems: "center", paddingHorizontal: space.md, paddingVertical: space.lg }}>
              <Text
                style={{
                  color: palette().textElevatedMuted,
                  fontSize: textSize(12),
                  lineHeight: textLineHeight(12, 1.4),
                  textAlign: "center",
                }}
              >
                {props.emptyLabel ?? tr("common.noMatchingOptions")}
              </Text>
            </View>
          </If>
        </View>
      </Scroll>
    </View>
  );
}

export function SelectDropdown<T extends string = string>(props: SelectDropdownProps<T>) {
  const open = signal(false);
  const query = signal("");
  const anchorRef = signal<ViewRef | null>(null);
  const listRef = signal<ViewRef | null>(null);
  const activeOption = signal<ViewRef | null>(null);
  const effectivePlacement = signal<Placement | null>(null);
  const availableHeight = signal<number | null>(null);
  // A full-width field opens a menu exactly as wide as itself.
  const triggerWidth = signal(0);
  const ghost = () => props.variant === "ghost";
  const colors = designControlColors;
  const placeholderColor = () => colors()?.fieldPlaceholder ?? palette().textElevatedMuted;
  const selectedOption = () => props.options.find(opt => opt.value === props.value);

  const selectedLabel = () => selectedOption()?.label ?? props.placeholder ?? tr("common.selectEllipsis");

  const visibleOptions = () => {
    const needle = query().trim().toLowerCase();
    if (!needle) return props.options;
    return props.options.filter(
      opt =>
        opt.label.toLowerCase().includes(needle) ||
        (opt.description ?? "").toLowerCase().includes(needle),
    );
  };

  const closeMenu = (restoreFocus: boolean) => {
    if (!open()) return;
    open.set(false);
    query.set("");
    effectivePlacement.set(null);
    availableHeight.set(null);
    listRef.set(null);
    activeOption.set(null);
    if (restoreFocus) anchorRef()?.focus();
  };

  effect(() => {
    if (props.disabled) untracked(() => closeMenu(false));
  });

  const onTriggerKey = ({ key, modifiers, defaultPrevented }: KeyEvent) => {
    if (props.disabled || open() || modifiers.alt || modifiers.control || modifiers.platform) return;
    if (key === "ArrowDown" || key === "ArrowUp") {
      open.set(true);
      return;
    }
    const edge = key === "Home" || key === "End";
    const printable = !defaultPrevented && key.length === 1 && key.trim();
    if (!edge && !printable) return;
    const options = props.options.filter(option => !option.disabled);
    let match: SelectDropdownOption<T> | undefined;
    if (edge) {
      match = key === "Home" ? options[0] : options.at(-1);
    } else {
      const next = options.findIndex(option => option.value === props.value) + 1;
      const prefix = key.toLowerCase();
      match = [...options.slice(next), ...options.slice(0, next)]
        .find(option => option.label.trimStart().toLowerCase().startsWith(prefix));
    }
    if (match && match.value !== props.value) props.onChange(match.value);
  };

  const resolvedMinWidth = (): number | undefined => {
    if (props.minWidth !== undefined) return props.minWidth;
    if ((props.variant ?? "default") === "ghost") return 0;
    if (props.maxWidth !== undefined) return Math.min(160, props.maxWidth);
    return 160;
  };

  const resolvedMaxHeight = (): number => {
    const avail = availableHeight();
    if (avail && avail > 0) return Math.max(120, Math.min(340, Math.floor(avail - 4)));
    return 340;
  };

  return (
    <View
      onFocusOut={() => { if (!props.searchable) closeMenu(false); }}
      style={[
        {
          flex: props.fullWidth ? 1 : undefined,
          width: props.fullWidth ? "100%" : undefined,
          minWidth: props.fullWidth ? 0 : resolvedMinWidth(),
          maxWidth: props.maxWidth ?? "100%",
          flexShrink: 1,
        },
        props.style,
      ]}
    >
      <View
        ref={el => anchorRef.set(el)}
        role="combobox"
        testID={props.testID}
        onLayout={event => {
          const w = Math.floor(event.bounds.size.width);
          if (w > 0 && Math.abs(w - triggerWidth()) > 1) triggerWidth.set(w);
        }}
        disabled={props.disabled}
        focusable={!props.disabled}
        captureKeys={props.disabled || open() ? "none" : ["up", "down", "home", "end"]}
        onKeyDown={onTriggerKey}
        hitSlop={touchSlop(controlHeight[props.size ?? "md"])}
        accessibilityLabel={props.accessibilityLabel}
        accessibilityDescription={props.accessibilityDescription}
        accessibilityControls={listRef()}
        accessibilityActiveDescendant={props.searchable ? null : activeOption()}
        accessibilityState={{
          expanded: open(),
          disabled: Boolean(props.disabled),
        }}
        onPress={() => {
          if (props.disabled) return;
          if (open()) closeMenu(true);
          else {
            if (!props.searchable) anchorRef()?.focus();
            open.set(true);
          }
        }}
        style={{
          boxSizing: "border-box",
          height: controlHeight[props.size ?? "md"],
          minWidth: 0,
          maxWidth: "100%",
          paddingHorizontal: ghost() ? space.sm : select.padding,
          paddingVertical: 0,
          borderRadius: select.radius,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: ghost() ? open() ? palette().border : "transparent"
            : open() ? colors()?.fieldBorderHover ?? palette().borderFocus
            : colors()?.fieldBorder ?? (isLightAppearance() ? palette().border : "transparent"),
          backgroundColor: ghost() ? open() ? palette().surfaceSubtle : "transparent"
            : colors() ? palette().inputBg : isLightAppearance() ? palette().canvasSubtle : palette().surfaceSubtle,
          boxShadow: !ghost() && !colors() && open() ? `0 0 0 2px ${palette().accentSoft}` : undefined,
          flexDirection: "row",
          alignItems: "center",
          gap: ghost() ? space.xs : select.gap,
          cursor: props.disabled ? "not-allowed" : "pointer",
          userSelect: "none",
          ...pressTransition(MOTION_DURATION.fast),
        }}
        hoverStyle={props.disabled ? undefined : {
          borderColor: ghost() ? open() ? palette().border : "transparent"
            : colors()?.fieldBorderHover ?? (isLightAppearance() ? palette().borderStrong : palette().border),
          backgroundColor: ghost() ? palette().surfaceSubtle : colors()?.fieldBackgroundHover ?? palette().buttonSecondaryHover,
        }}
        activeStyle={tactileActiveStyle(0.98)}
        focusVisibleStyle={focusRingStyle()}
        disabledStyle={{ opacity: colors()?.disabledOpacity ?? 0.48 }}
      >
        <Text
          style={{
            ...textStyle("label", { color: props.disabled ? colors()?.contentDisabled ?? palette().textMuted
              : selectedOption() ? palette().text : placeholderColor() }),
            flex: ghost() ? undefined : 1,
            flexShrink: 1,
            minWidth: 0,
            numberOfLines: 1,
            textOverflow: "ellipsis",
          }}
        >
          {selectedLabel()}
        </Text>
        <Icon
          name={open() ? "chevron-up" : "chevron-down"}
          size={select.indicator}
          color={placeholderColor()}
        />
      </View>

      <If when={open()}>
        <Overlay
          anchor={anchorRef()}
          placement={props.placement ?? "bottom"}
          align={props.align ?? "start"}
          offset={4}
          margin={8}
          onPosition={pos => {
            effectivePlacement.set(pos.placement);
            availableHeight.set(pos.available.height);
          }}
          onPressOutside={() => closeMenu(false)}
          onCancel={() => closeMenu(true)}
        >
          <SelectPopoverSurface
            options={visibleOptions()}
            value={props.value}
            placement={effectivePlacement() ?? props.placement ?? "bottom"}
            align={props.align ?? "start"}
            searchable={props.searchable}
            searchPlaceholder={props.searchPlaceholder}
            emptyLabel={props.emptyLabel}
            minWidth={
              props.fullWidth && triggerWidth() > 0
                ? Math.max(200, triggerWidth())
                : Math.max(200, props.minWidth ?? 180)
            }
            maxHeight={resolvedMaxHeight()}
            query={query()}
            listRef={listRef.set}
            onActiveOption={activeOption.set}
            onQueryChange={q => query.set(q)}
            onSelect={val => {
              closeMenu(true);
              if (!props.disabled) props.onChange(val);
            }}
            onClose={() => closeMenu(true)}
          />
        </Overlay>
      </If>
    </View>
  );
}

export type ToastTone = "neutral" | "info" | "success" | "warning" | "danger" | "error";

export interface ToastEntry {
  id: string;
  message: string;
  tone: ToastTone;
}

interface InternalToastEntry extends ToastEntry {
  exiting?: boolean;
}

interface ToastTimerState {
  timer: ReturnType<typeof setTimeout> | null;
  remainingMs: number;
  startedAt: number;
}

const TOAST_EXIT_MS = 160;
const toasts = signal<InternalToastEntry[]>([]);
const toastTimers = new Map<string, ToastTimerState>();
const toastExitTimers = new Map<string, ReturnType<typeof setTimeout>>();
let toastSeq = 0;
let toastsPaused = false;

function clearToastTimer(id: string): void {
  const rec = toastTimers.get(id);
  if (rec?.timer) clearTimeout(rec.timer);
  toastTimers.delete(id);
}

function removeToastNow(id: string): void {
  clearToastTimer(id);
  const exitHandle = toastExitTimers.get(id);
  if (exitHandle) {
    clearTimeout(exitHandle);
    toastExitTimers.delete(id);
  }
  toasts.update(current => current.filter(item => item.id !== id));
}

function scheduleToastTimer(id: string, ms: number): void {
  clearToastTimer(id);
  if (ms <= 0) return;
  if (toastsPaused) {
    toastTimers.set(id, { timer: null, remainingMs: ms, startedAt: 0 });
    return;
  }
  const startedAt = Date.now();
  const timer = setTimeout(() => {
    toastTimers.delete(id);
    dismissToast(id);
  }, ms);
  toastTimers.set(id, { timer, remainingMs: ms, startedAt });
}

function setToastsPaused(paused: boolean): void {
  if (toastsPaused === paused) return;
  toastsPaused = paused;
  const now = Date.now();
  if (paused) {
    for (const [id, rec] of toastTimers.entries()) {
      if (rec.timer) {
        clearTimeout(rec.timer);
        const elapsed = rec.startedAt > 0 ? Math.max(0, now - rec.startedAt) : 0;
        rec.remainingMs = Math.max(450, rec.remainingMs - elapsed);
        rec.timer = null;
        rec.startedAt = 0;
        toastTimers.set(id, rec);
      }
    }
  } else {
    for (const [id, rec] of Array.from(toastTimers.entries())) {
      if (!rec.timer && rec.remainingMs > 0) {
        scheduleToastTimer(id, rec.remainingMs);
      }
    }
  }
}

export function dismissToast(id: string): void {
  clearToastTimer(id);
  const existing = toasts().find(item => item.id === id);
  if (!existing || existing.exiting) return;
  toasts.update(current =>
    current.map(item => (item.id === id ? { ...item, exiting: true } : item)),
  );
  const exitHandle = setTimeout(() => {
    toastExitTimers.delete(id);
    removeToastNow(id);
  }, reduceMotion() ? 80 : TOAST_EXIT_MS);
  toastExitTimers.set(id, exitHandle);
}

export const DEFAULT_TOAST_DURATION_MS = 6000;

function defaultToastDurationMs(_tone: ToastTone): number {
  return DEFAULT_TOAST_DURATION_MS;
}

export function pushToast(
  message: string,
  tone: ToastTone = "neutral",
  durationMs?: number,
): string {
  const resolvedDuration = durationMs !== undefined ? durationMs : defaultToastDurationMs(tone);
  const id = `toast-${++toastSeq}`;
  const current = toasts();
  const active = current.filter(t => !t.exiting);
  if (active.length >= 3) {
    const dropped = active.slice(0, active.length - 2);
    for (const d of dropped) clearToastTimer(d.id);
    const dropIds = new Set(dropped.map(d => d.id));
    toasts.set([...current.filter(item => !dropIds.has(item.id)), { id, message, tone }]);
  } else {
    toasts.set([...current, { id, message, tone }]);
  }
  if (resolvedDuration > 0) {
    scheduleToastTimer(id, resolvedDuration);
  }
  return id;
}

function toastToneTokens(tone: ToastTone): {
  color: string;
  border: string;
  icon: IconName;
} {
  if (tone === "success") {
    return {
      color: palette().success,
      border: palette().successBorder,
      icon: "check-circle",
    };
  }
  if (tone === "warning") {
    return {
      color: palette().warning,
      border: palette().warningBorder,
      icon: "warning",
    };
  }
  if (tone === "danger" || tone === "error") {
    return {
      color: palette().danger,
      border: palette().dangerBorder,
      icon: "alert-circle",
    };
  }
  if (tone === "info") {
    return {
      color: palette().accent,
      border: palette().accentBorder,
      icon: "info",
    };
  }
  return {
    color: palette().textSecondary,
    border: palette().border,
    icon: "info",
  };
}

function ToastCard(props: { entry: InternalToastEntry }) {
  const motion = createMotion({
    enter: reduceMotion()
      ? {
          keyframes: { opacity: [0, 1] },
          duration: 120,
          easing: "ease",
          ignoreReduceMotion: true,
        }
      : {
          keyframes: {
            opacity: [0, 1],
            translateY: [10, 0],
            scale: [0.97, 1],
          },
          duration: MOTION_DURATION.toast,
          easing: MOTION_EASE_STANDARD_BEZIER,
        },
  });

  let exitPlayed = false;
  effect(() => {
    if (props.entry.exiting && !exitPlayed) {
      exitPlayed = true;
      void motion.play(
        reduceMotion()
          ? {
              keyframes: { opacity: [1, 0] },
              duration: 80,
              easing: "ease",
              ignoreReduceMotion: true,
            }
          : {
              keyframes: {
                opacity: [1, 0],
                translateY: [0, 6],
                scale: [1, 0.97],
              },
              duration: TOAST_EXIT_MS,
              easing: MOTION_EASE_STANDARD_BEZIER,
            },
      );
    }
  });

  return (
    <View
      role="alert"
      accessibilityLabel={props.entry.message}
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          paddingHorizontal: space.lg,
          paddingVertical: space.md,
          borderRadius: radii.lg,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: toastToneTokens(props.entry.tone).border,
          backgroundColor: palette().glassOverlayBg,
          backdropFilter: "blur(16px) saturate(1.2)",
          boxShadow: elevationShadow(2),
          width: compactLayout() ? "100%" : undefined,
          maxWidth: compactLayout() ? "100%" : 380,
          pointerEvents: "box-none",
        },
        motion.style,
      ]}
    >
      <View style={{ flexShrink: 0, pointerEvents: "none" }}>
        <Icon
          name={toastToneTokens(props.entry.tone).icon}
          size={15}
          color={toastToneTokens(props.entry.tone).color}
        />
      </View>
      <Text
        style={{
          flex: 1,
          minWidth: 0,
          color: palette().text,
          fontSize: textSize(13),
          fontWeight: "500",
          lineHeight: textLineHeight(13, 1.4),
          numberOfLines: 3,
          textOverflow: "ellipsis",
          pointerEvents: "none",
        }}
      >
        {props.entry.message}
      </Text>
      <View
        role="button"
        accessibilityLabel={`dismiss-${props.entry.id}`}
        hitSlop={touchSlop(controlHeight.xs)}
        onPress={() => dismissToast(props.entry.id)}
        style={{
          width: controlHeight.xs,
          height: controlHeight.xs,
          flexShrink: 0,
          borderRadius: radii.xs,
          borderCurve: "continuous",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          userSelect: "none",
          ...pressTransition(MOTION_DURATION.fast),
        }}
        hoverStyle={{ backgroundColor: palette().surfaceSubtle }}
        activeStyle={tactileActiveStyle(0.96, { backgroundColor: palette().panelHover })}
        focusVisibleStyle={focusRingStyle()}
      >
        <Icon name="close" size={12} color={palette().textElevatedMuted} />
      </View>
    </View>
  );
}

export function ToastHost(props: { bottomOffset?: number } = {}) {
  const hovered = signal(false);

  effect(() => {
    const appHidden = lifecycle() !== "active";
    setToastsPaused(hovered() || appHidden);
  });

  cleanup(() => {
    setToastsPaused(false);
  });

  return (
    <If when={toasts().length > 0}>
      <Overlay
        accessibilityLabel="toast-host"
        style={
          compactLayout()
            ? {
                left: space.sm + safeArea().left,
                right: space.sm + safeArea().right,
                bottom: space.md + safeArea().bottom + (props.bottomOffset ?? 0),
                alignItems: "flex-start",
                pointerEvents: "box-none",
              }
            : {
                left: space.lg,
                bottom: space.lg + (props.bottomOffset ?? 0),
                alignItems: "flex-start",
                pointerEvents: "box-none",
              }
        }
      >
        <View
          onMouseEnter={() => hovered.set(true)}
          onMouseLeave={() => hovered.set(false)}
          style={{
            gap: space.sm,
            alignItems: "flex-start",
            pointerEvents: "box-none",
          }}
        >
          <Each of={toasts()} key={item => item.id}>
            {item => <ToastCard entry={item()} />}
          </Each>
        </View>
      </Overlay>
    </If>
  );
}
