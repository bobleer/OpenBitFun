// Global Remote Connect disclaimer modal: shown before account sign-in (and
// before first-time chat-app connector setup if the user hasn't signed in), as
// well as on demand from Settings › Account › Devices › Chat apps.

import { signal, Text, View } from "nsh";
import { tr, type MessageKey } from "../i18n";
import {
  agreeRemoteDisclaimer,
  declineRemoteDisclaimer,
  remoteDisclaimerAgreed,
  remoteDisclaimerOpen,
} from "../remoteDisclaimerStore";
import { compactLayout, controlHeight, layout, palette, radii, space, textStyle, touchSlop } from "../theme";
import { stateColor } from "./fleet";
import { Icon } from "./icons";
import { MOTION_DURATION, pressTransition, tactileActiveStyle } from "./motion";
import { ModalDialog } from "./overlays";
import { Button, focusRingStyle } from "./primitives";

const DISCLAIMER_KEY_ITEMS = [
  "devices.remote.disclaimerItemGeneralRisk",
  "devices.remote.disclaimerItemSecurity",
  "devices.remote.disclaimerItemEncryption",
  "devices.remote.disclaimerItemPrivacy",
] as const;

const DISCLAIMER_DETAIL_ITEMS = [
  "devices.remote.disclaimerItemOpenSource",
  "devices.remote.disclaimerItemDataUsage",
  "devices.remote.disclaimerItemCredentials",
  "devices.remote.disclaimerItemQrCode",
  "devices.remote.disclaimerItemRelay",
  "devices.remote.disclaimerItemNetwork",
  "devices.remote.disclaimerItemBot",
  "devices.remote.disclaimerItemBotPersistence",
  "devices.remote.disclaimerItemMobileBrowser",
  "devices.remote.disclaimerItemCompliance",
  "devices.remote.disclaimerItemLiability",
] as const;

function DisclaimerList(props: { items: readonly MessageKey[]; start: number }) {
  return (
    <View style={{ gap: space.sm }}>
      <Each of={props.items}>
        {(key, index) => (
          <View style={{ flexDirection: "row", gap: space.sm, alignItems: "flex-start" }}>
            <Text
              style={{
                width: space.xl,
                flexShrink: 0,
                ...textStyle("label", { color: palette().textMuted }),
                fontWeight: "400",
              }}
            >
              {`${props.start + index()}.`}
            </Text>
            <Text
              style={{
                flex: 1,
                minWidth: 0,
                ...textStyle("label", { color: palette().textSecondary }),
                fontWeight: "400",
              }}
            >
              {tr(key())}
            </Text>
          </View>
        )}
      </Each>
    </View>
  );
}

/** Remote Connect disclaimer dialog: a gate before account sign-in or first remote connection. */
export function RemoteDisclaimerModal() {
  const detailsOpen = signal(false);
  return (
    <ModalDialog
      open={remoteDisclaimerOpen()}
      title={tr("devices.remote.disclaimerTitle")}
      size="md"
      accessibilityLabel="remote-disclaimer-modal"
      onClose={() => declineRemoteDisclaimer()}
      footer={
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: space.sm, flex: 1 }}>
          <Button
            label={remoteDisclaimerAgreed() ? tr("common.close") : tr("devices.remote.disclaimerDecline")}
            variant="secondary"
            size="md"
            accessibilityLabel="remote-disclaimer-decline"
            onPress={() => declineRemoteDisclaimer()}
          />
          <If when={!remoteDisclaimerAgreed()}>
            <Button
              label={tr("devices.remote.disclaimerAgree")}
              variant="primary"
              size="md"
              accessibilityLabel="remote-disclaimer-agree"
              onPress={() => void agreeRemoteDisclaimer()}
            />
          </If>
        </View>
      }
    >
      <View style={{ gap: space.lg }}>
        <Text
          style={textStyle("caption", {
            color: remoteDisclaimerAgreed() ? palette().textMuted : stateColor("needs_you"),
          })}
        >
          {remoteDisclaimerAgreed()
            ? tr("devices.remote.disclaimerStatusAgreed")
            : tr("devices.remote.disclaimerStatusPending")}
        </Text>
        <Text
          style={{
            ...textStyle("label", { color: palette().textSecondary }),
            fontWeight: "400",
          }}
        >
          {tr("devices.remote.disclaimerIntro")}
        </Text>
        <Text style={textStyle("body", { color: palette().text })}>{tr("devices.remote.disclaimerKeyRisks")}</Text>
        <DisclaimerList items={DISCLAIMER_KEY_ITEMS} start={1} />
        <View
          role="button"
          accessibilityLabel="remote-disclaimer-details"
          accessibilityState={{ expanded: detailsOpen() }}
          hitSlop={touchSlop(controlHeight.sm)}
          onPress={() => detailsOpen.update(open => !open)}
          hoverStyle={{ backgroundColor: palette().panelHover }}
          activeStyle={tactileActiveStyle(0.98)}
          focusVisibleStyle={focusRingStyle()}
          style={{
            alignSelf: "flex-start",
            minHeight: compactLayout() ? layout.touchTarget : controlHeight.sm,
            paddingHorizontal: space.sm,
            marginLeft: -space.sm,
            borderRadius: radii.md,
            borderCurve: "continuous",
            flexDirection: "row",
            alignItems: "center",
            gap: space.xs,
            cursor: "pointer",
            userSelect: "none",
            ...pressTransition(MOTION_DURATION.fast),
          }}
        >
          <Icon name={detailsOpen() ? "chevron-down" : "chevron-right"} size={14} color={palette().textMuted} />
          <Text style={textStyle("label", { color: palette().textSecondary })}>
            {tr("devices.remote.disclaimerFullDetails")}
          </Text>
        </View>
        <If when={detailsOpen()}>
          <DisclaimerList items={DISCLAIMER_DETAIL_ITEMS} start={5} />
        </If>
      </View>
    </ModalDialog>
  );
}
