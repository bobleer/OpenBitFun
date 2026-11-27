import { computed, effect, signal, Text, View } from "nsh";
import type { TranscriptTurnView } from "../api";
import { formatCount, toolCallOf, type ToolCallView } from "../format";
import { tr, type MessageKey } from "../i18n";
import { space, textStyle } from "../theme";
import { detailedToolCall, loadToolDetail, toolDetailState } from "../toolDetailStore";
import { normalizeToolName, toolInputRecord } from "../toolPresentation";
import { ActionCard } from "./ActionCard";
import { ModalDialog } from "./overlays";
import { Button, InlineBanner } from "./primitives";

const REVIEW_TOOLS = new Set(["launchreviewagent", "task", "agentspawn", "agentfork"]);
type CheckState = "completed" | "partial" | "skipped" | "cancelled" | "failed" | "active" | "unknown";
const STATE_LABEL: Record<CheckState, MessageKey> = {
  completed: "review.progress.completed", partial: "review.progress.partial",
  skipped: "review.progress.skipped", cancelled: "review.progress.cancelled",
  failed: "review.progress.failed", active: "review.progress.active", unknown: "review.progress.unknown",
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resultState(call: ToolCallView): CheckState {
  const status = toolInputRecord(call.result).status;
  if (status === "partial_timeout") return "partial";
  if (status === "capacity_skipped") return "skipped";
  if (status === "cancelled" || call.status === "cancelled") return "cancelled";
  if (status === "timed_out" || status === "failed" || call.success === false ||
      ["error", "failed", "rejected", "interrupted"].includes(call.status ?? "")) return "failed";
  if (status === "completed" || call.success === true || call.status === "completed") return "completed";
  return ["running", "queued", "waiting", "confirmation", "pending_confirmation"].includes(call.status ?? "")
    ? "active" : "unknown";
}

function checkOf(call: ToolCallView) {
  const tool = normalizeToolName(call.name);
  if (!call.id || !REVIEW_TOOLS.has(tool)) return null;
  const args = toolInputRecord(call.input);
  const reviewer = text(args.subagent_type ?? args.subagentType ?? args.agent_type ?? args.agentType);
  if (tool !== "launchreviewagent" && !reviewer.startsWith("Review")) return null;
  return { id: call.id, call, state: resultState(call), label: text(args.description) || reviewer };
}

function savedOutput(call: ToolCallView): string {
  const result = toolInputRecord(call.result);
  const output = text(result.partial_output ?? result.partialOutput ?? result.output ?? result.result ??
    toolInputRecord(result.summary).overall_assessment ?? (typeof call.result === "string" ? call.result : undefined));
  if (output) return output;
  // Current workers put completed findings inside the model-facing result envelope.
  const message = call.resultForAssistant ?? "";
  const start = message.indexOf("<result>");
  const end = message.lastIndexOf("</result>");
  return start >= 0 && end > start ? message.slice(start + "<result>".length, end).trim() : "";
}

export function ReviewProgress(props: {
  scope: () => string;
  turns: () => readonly TranscriptTurnView[];
  live: () => { turnId: string | null; calls: ToolCallView[] } | null;
  width: () => number;
  padding: () => number;
}) {
  const latest = computed(() => props.turns().findLast(turn => turn.kind === "user_dialog") ?? null);
  const saved = computed(() => {
    const turn = latest();
    return turn?.items.flatMap(item => item.kind === "tool" ? [toolCallOf(item.tool, turn)] : []) ?? [];
  });
  const current = computed(() => {
    if (!props.scope()) return null;
    const live = props.live();
    const turn = latest();
    const calls = !live ? saved() : live.turnId !== turn?.turnId ? live.calls
      : [...new Map([...saved(), ...live.calls].map(call => [call.id, call])).values()];
    const reported = calls.some(call => normalizeToolName(call.name) === "submitcodereview" &&
      resultState(call) === "completed");
    const checks = calls.map(checkOf).filter(check => check !== null);
    if (reported || !checks.length) return null;
    const settled = !live && turn?.settled;
    const interrupted = settled && (turn.status === "failed" || turn.status === "cancelled" ||
      turn.recovery?.status === "interrupted");
    return { checks, settled, interrupted };
  });
  const key = computed(() => JSON.stringify([props.scope(), props.live()?.turnId ?? latest()?.turnId]));
  const open = signal(false);
  const selected = signal("");
  effect(() => { key(); open.set(false); selected.set(""); });
  const activeCheck = computed(() => current()?.checks.find(check => check.id === selected()));
  const output = computed(() => {
    const check = activeCheck();
    if (!check) return "";
    const call = detailedToolCall(check.call);
    return savedOutput(call) || call.error || "";
  });

  return <If when={current()}>{state => {
    const summary = () => tr("review.progress.count", {
      handled: formatCount(state().checks.filter(check => check.state !== "active" && check.state !== "unknown").length),
      total: formatCount(state().checks.length),
    });
    return <>
      <View style={{ paddingHorizontal: props.padding(), paddingTop: space.sm }}>
        <View style={{ maxWidth: props.width(), width: "100%", alignSelf: "center" }}>
          <InlineBanner tone={state().settled ? "warning" : "info"} icon="clock"
            title={tr(state().interrupted ? "review.progress.interrupted"
              : state().settled ? "review.progress.noReport" : "review.progress.title")}
            message={summary()} actionLabel={tr("review.progress.view")}
            onAction={() => open.set(true)} />
        </View>
      </View>
      <ModalDialog open={open()} title={tr("review.progress.view")} subtitle={summary()}
        size="lg" accessibilityLabel="review-progress-dialog" onClose={() => open.set(false)}>
        <View style={{ gap: space.sm }}>
          <Each of={state().checks} key={check => check.id}>
            {(check, index) => <ActionCard icon="list" compact testID={`review-check-${check().id}`}
              label={check().label || tr("review.progress.check", { number: formatCount(index() + 1) })}
              detail={tr(STATE_LABEL[check().state])}
              selected={selected() === check().id}
              onPress={() => { selected.set(check().id); void loadToolDetail(check().call); }} />}
          </Each>
          <If when={activeCheck()}>{check =>
            <If when={toolDetailState(check().call) === "whole"} else={
              <If when={toolDetailState(check().call) === "failed"} else={
                <Text style={textStyle("caption")}>{tr("common.loading")}</Text>
              }>
                <Button label={tr("common.retry")} variant="secondary" size="sm"
                  onPress={() => void loadToolDetail(check().call)} />
              </If>
            }>
              <Text style={{ ...textStyle("body"), userSelect: "text" }} testID="review-check-output">
                {output() || tr("review.progress.noOutput")}
              </Text>
            </If>
          }</If>
        </View>
      </ModalDialog>
    </>;
  }}</If>;
}
