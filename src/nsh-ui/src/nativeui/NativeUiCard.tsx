// A NativeUI card in the transcript: the card the Agent wrote, run by the
// host's nested engine (`nativeCardHost`), or, where it cannot run, its title,
// the reason and its source.
//
// What a card asks for reaches the reader, never the backend directly: `ask`
// fills the composer for the reader to send, links open through the system's
// browser, copies go to the clipboard. State a card keeps (`persisted`) lives
// per card while this window shows the transcript.

import { Clipboard, computed, openUrl, signal, Text, View } from "nsh";
import type { JSX, Signal } from "nsh";
import type { ToolCallView } from "../format";
import { tr } from "../i18n";
import { composerText } from "../state";
import { fontMono, palette, radii, space, textLineHeight, textSize, uiFontScale } from "../theme";
import { Icon } from "../ui/icons";
import { pushToast } from "../ui/overlays";
import { Button } from "../ui/primitives";
import type { ToolRunState } from "../ui/toolCards";
import { nativeCardHost, nativeUiCallOf, unsupportedReason, type NativeUiCall } from "./nativeCardHost";

/** Card state by card, for the lifetime of this window. */
const cardStates = new Map<string, Record<string, unknown>>();

/** The palette subset the card kit reads (`theme()` in a card). */
function cardTheme(): Record<string, unknown> {
  const p = palette();
  return {
    canvas: p.canvas,
    panelRaised: p.panelRaised,
    surfaceTertiary: p.surfaceTertiary,
    inputBg: p.inputBg,
    border: p.border,
    borderSubtle: p.borderSubtle,
    text: p.text,
    textSecondary: p.textSecondary,
    textMuted: p.textMuted,
    accent: p.accent,
    accentSoft: p.accentSoft,
    actionPrimaryBg: p.actionPrimaryBg,
    actionPrimaryFg: p.actionPrimaryFg,
    buttonSecondaryBg: p.buttonSecondaryBg,
    buttonSecondaryHover: p.buttonSecondaryHover,
    success: p.success,
    successSoft: p.successSoft,
    warning: p.warning,
    warningSoft: p.warningSoft,
    danger: p.danger,
    dangerSoft: p.dangerSoft,
    toggleTrackOff: p.toggleTrackOff,
    switchOn: p.switchOn,
    series: [p.accent, p.brandWarm, p.success, p.warning, p.danger, p.accentBorder],
    fontScale: uiFontScale(),
    fontMono: fontMono(),
  };
}

export function NativeUiToolItem(props: {
  call: ToolCallView;
  cardId: string;
  status: ToolRunState;
  fallback: JSX.Element;
}) {
  const card = computed(() => nativeUiCallOf(props.call));
  return (
    <If when={props.status !== "failed" && props.status !== "cancelled"} else={props.fallback}>
      <If when={card()?.factory} else={<NativeUiPending title={card()?.title ?? ""} />}>
        <NativeUiCardView card={card()!} cardId={props.call.id || props.cardId} />
      </If>
    </If>
  );
}

function CardTitle(props: { title: string; trailing?: JSX.Element }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 22 }}>
      <Icon name="sparkles" size={14} color={palette().accent} />
      <Text
        style={{
          flex: 1,
          minWidth: 0,
          color: palette().textSecondary,
          fontSize: textSize(12),
          lineHeight: textLineHeight(12, 1.3),
          fontWeight: "500",
          numberOfLines: 1,
          textOverflow: "ellipsis",
        }}
      >
        {props.title || tr("nativeUi.untitled")}
      </Text>
      {props.trailing}
    </View>
  );
}

function NativeUiPending(props: { title: string }) {
  return (
    <View
      accessibilityLabel="native-ui-building"
      style={{
        gap: space.sm,
        paddingVertical: space.md,
        paddingHorizontal: space.lg,
        borderRadius: radii.lg,
        borderCurve: "continuous",
        backgroundColor: palette().surfaceSubtle,
      }}
    >
      <CardTitle title={props.title} />
      <View style={{ width: "70%", height: space.sm + space.hair, borderRadius: radii.sm, backgroundColor: palette().skeletonBg }} />
      <Text style={{ color: palette().textMuted, fontSize: textSize(12), lineHeight: textLineHeight(12, 1.4) }}>
        {tr("nativeUi.building")}
      </Text>
    </View>
  );
}

function NativeUiCardView(props: { card: NativeUiCall; cardId: string }) {
  const failure = signal("");
  const showSource = signal(false);
  const host = computed(() => nativeCardHost());
  const reason = computed(() => unsupportedReason(props.card));
  const state = cardStates.get(props.cardId) ?? {};
  cardStates.set(props.cardId, state);

  const ask = (event: { text?: string }) => {
    const text = String(event.text ?? "").trim();
    if (!text) return;
    composerText.set(text);
    pushToast(tr("nativeUi.askReady"), "info");
  };
  const copy = (event: { text?: string }) => {
    void Clipboard.writeText(String(event.text ?? "")).then(
      () => pushToast(tr("common.copied"), "success"),
      () => undefined,
    );
  };
  const open = (event: { url?: string }) => {
    const url = String(event.url ?? "");
    if (/^https?:\/\//i.test(url)) void openUrl(url).catch(() => pushToast(tr("nativeUi.openFailed"), "error"));
  };

  return (
    <View style={{ width: "100%", gap: space.sm }}>
      <CardTitle
        title={props.card.title}
        trailing={
          <Button
            label={showSource() ? tr("nativeUi.hideSource") : tr("nativeUi.viewSource")}
            variant="ghost"
            size="xs"
            accessibilityLabel={`native-ui-source-${props.cardId}`}
            onPress={() => showSource.set(!showSource())}
          />
        }
      />
      <If
        when={host() && !reason()}
        else={<NativeUiUnavailable reason={reason() ? "version" : "host"} />}
      >
        {() => {
          const Card = host()!.Card;
          return (
            <Card
              factory={props.card.factory!}
              theme={cardTheme()}
              state={state}
              style={{ width: "100%", alignSelf: "stretch", minHeight: 24 }}
              onAsk={ask}
              onCopy={copy}
              onOpenUrl={open}
              onState={event => {
                if (typeof event.key === "string" && event.key) state[event.key] = event.value;
              }}
              onError={event => failure.set(String(event.message ?? "").slice(0, 400))}
            />
          );
        }}
      </If>
      <If when={failure()}>
        <Text style={{ color: palette().danger, fontSize: textSize(12), lineHeight: textLineHeight(12, 1.4) }}>
          {tr("nativeUi.failed", { message: failure() })}
        </Text>
      </If>
      <If when={showSource()}>
        <SourceView source={props.card.source} visible={showSource} />
      </If>
    </View>
  );
}

function NativeUiUnavailable(props: { reason: "host" | "version" }) {
  return (
    <View
      style={{
        paddingVertical: space.sm,
        paddingHorizontal: space.md,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: palette().borderSubtle,
        backgroundColor: palette().surfaceTertiary,
      }}
    >
      <Text style={{ color: palette().textMuted, fontSize: textSize(12), lineHeight: textLineHeight(12, 1.4) }}>
        {props.reason === "host" ? tr("nativeUi.unsupportedHost") : tr("nativeUi.unsupportedVersion")}
      </Text>
    </View>
  );
}

function SourceView(props: { source: string; visible: Signal<boolean> }) {
  return (
    <View style={{ gap: space.xs }}>
      <Text
        style={{
          color: palette().text,
          fontFamily: fontMono(),
          fontSize: textSize(11),
          lineHeight: textLineHeight(11, 1.45),
          padding: space.md,
          borderRadius: radii.md,
          backgroundColor: palette().surfaceTertiary,
        }}
      >
        {props.source || tr("nativeUi.noSource")}
      </Text>
      <View style={{ flexDirection: "row", gap: space.xs }}>
        <Button
          label={tr("common.copy")}
          variant="ghost"
          size="xs"
          onPress={() => {
            void Clipboard.writeText(props.source).then(
              () => pushToast(tr("common.copied"), "success"),
              () => undefined,
            );
          }}
        />
      </View>
    </View>
  );
}
