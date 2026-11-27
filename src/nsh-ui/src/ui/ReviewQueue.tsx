import { computed, signal, Text, View } from "nsh";
import { connectionState, fleetActive, invokeCommand } from "../bridge";
import { fleetDeviceById } from "../fleetStore";
import { formatCount, formatDuration, formatPlural } from "../format";
import { localizeHostError, tr, type MessageKey } from "../i18n";
import { reviewQueueFor, type ReviewQueueSample } from "../reviewQueueStore";
import type { ReviewTarget } from "../reviewStore";
import { openDeviceSettings } from "../scenes/SettingsScene";
import { sessionKey } from "../state";
import { space, textStyle } from "../theme";
import { pushToast } from "./overlays";
import { Button, InlineBanner } from "./primitives";

const REASONS: Record<string, MessageKey> = {
  provider_rate_limit: "review.queue.rateLimit",
  provider_concurrency_limit: "review.queue.providerConcurrency",
  retry_after: "review.queue.retryAfter",
  local_concurrency_cap: "review.queue.localConcurrency",
  launch_batch_blocked: "review.queue.batchOrder",
  temporary_overload: "review.queue.overloaded",
};

type QueueAction = "pause" | "continue" | "skip_optional" | "cancel";

export function ReviewQueue(props: { target: () => ReviewTarget | null; padding: () => number; width: () => number }) {
  const key = () => {
    const target = props.target();
    return target ? sessionKey(target.sessionId, target.deviceId) : "";
  };
  const queue = computed(() => reviewQueueFor(key()));
  const waiting = () => queue()?.waiting ?? [];
  const controls = computed(() => {
    const target = props.target();
    if (fleetActive() && (!target?.deviceId || fleetDeviceById(target.deviceId)?.hostKind !== "desktop")) return [];
    return waiting().filter(item => item.controlsAvailable === true);
  });
  const canPause = () => controls().some(item => item.status === "queued_for_capacity");
  const canContinue = () => controls().some(item => item.status === "paused_by_user");
  const canSkip = () => controls().some(item => (item.optionalReviewerCount ?? 0) > 0);
  const operation = () => JSON.stringify([key(), queue()?.turnId]);
  const pending = signal<string | null>(null);
  const busy = () => pending() === operation();
  const disabled = () => busy() || connectionState() !== "connected";

  function message(items: readonly ReviewQueueSample[]): string {
    const active = Math.max(0, ...items.map(item => item.activeReviewerCount ?? 0));
    const longest = items.reduce((previous, item) => (item.queueElapsedMs ?? 0) > (previous.queueElapsedMs ?? 0)
      ? item : previous, items[0]);
    const elapsed = formatDuration(longest?.queueElapsedMs);
    const maximum = longest?.maxQueueWaitSeconds;
    const reasons = [...new Set(items.map(item => item.reason))].flatMap(reason =>
      reason && Object.hasOwn(REASONS, reason) ? [tr(REASONS[reason])] : []);
    return [
      formatPlural(items.length, "review.queue.waitingOne", "review.queue.waitingOther"),
      active > 0 ? tr("review.queue.active", { count: formatCount(active) }) : "",
      ...reasons,
      elapsed ? tr("review.queue.elapsed", { duration: elapsed }) : "",
      maximum && longest.reason !== "launch_batch_blocked"
        ? tr("review.queue.waitLimit", { duration: formatDuration(maximum * 1000) }) : "",
    ].filter(Boolean).join(" · ");
  }

  async function control(action: QueueAction): Promise<void> {
    const target = props.target();
    const current = queue();
    if (!target || !current || disabled()) return;
    const selected = controls().filter(item => {
      if (action === "pause") return item.status === "queued_for_capacity";
      if (action === "continue") return item.status === "paused_by_user";
      if (action === "skip_optional") return (item.optionalReviewerCount ?? 0) > 0;
      return true;
    });
    if (!selected.length) return;
    const requested = operation();
    pending.set(requested);
    const route = fleetActive() && target.deviceId ? { target: target.deviceId } : undefined;
    try {
      const replies = await Promise.allSettled(selected.map(item => invokeCommand("control_deep_review_queue", {
        sessionId: target.sessionId, dialogTurnId: current.turnId, toolId: item.toolId, action,
      }, route)));
      const failed = replies.filter(reply => reply.status === "rejected");
      if (failed.length) pushToast(
        failed.length === selected.length ? localizeHostError(failed[0].reason) : tr("review.queue.partialFailure", {
          failed: formatCount(failed.length), total: formatCount(selected.length),
        }),
        "warning",
      );
    } finally {
      if (pending() === requested) pending.set(null);
    }
  }

  function openSettings(): void {
    const target = props.target();
    if (target) openDeviceSettings("execution", target.deviceId, "ai-execution");
  }

  return <If when={queue()}>{current =>
    <View style={{ paddingHorizontal: props.padding(), paddingTop: space.sm }}>
      <View style={{ maxWidth: props.width(), width: "100%", alignSelf: "center", gap: space.xs }}>
        <InlineBanner tone="info" icon="clock" accessibilityLabel="review-queue-notice"
          title={tr(current().waiting.every(item => item.status === "paused_by_user")
            ? "review.queue.paused" : "review.queue.title")}
          message={message(current().waiting)} />
        <If when={current().waiting.some(item => item.sessionConcurrencyHigh === true)}>
          <Text style={textStyle("caption")}>{tr("review.queue.sessionBusy")}</Text>
        </If>
        <If when={!controls().length}>
          <Text style={textStyle("caption")}>{tr("review.queue.stopHint")}</Text>
        </If>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs }}>
          <If when={canPause()}>
            <Button label={tr("review.queue.pause")} size="sm" variant="secondary"
              accessibilityLabel="review-queue-pause" disabled={disabled()} onPress={() => void control("pause")} />
          </If>
          <If when={canContinue()}>
            <Button label={tr("review.queue.continue")} size="sm" variant="secondary"
              accessibilityLabel="review-queue-continue" disabled={disabled()} onPress={() => void control("continue")} />
          </If>
          <If when={canSkip()}>
            <Button label={tr("review.queue.skipOptional")} size="sm" variant="secondary"
              accessibilityLabel="review-queue-skip" disabled={disabled()} onPress={() => void control("skip_optional")} />
          </If>
          <If when={controls().length}>
            <Button label={tr("review.queue.cancel")} size="sm" variant="ghost"
              accessibilityLabel="review-queue-cancel" disabled={disabled()} onPress={() => void control("cancel")} />
          </If>
          <Button label={tr("review.queue.settings")} size="sm" variant="ghost"
            accessibilityLabel="review-queue-settings" disabled={disabled()} onPress={openSettings} />
        </View>
      </View>
    </View>
  }</If>;
}
