import { Text, View, computed, effect, signal, untracked, type JSX, type Signal } from "nsh";
import type { ToolCallView } from "../format";
import { designTokens } from "../generated/designTokens";
import { tr } from "../i18n";
import {
  questionReplies, readQuestionResult, readQuestions,
  type QuestionAnswers, type QuestionDraft, type QuestionReply, type QuestionView,
} from "../questionDraft";
import { compactLayout, designControlColors, layout, palette, radii, space, textStyle } from "../theme";
import { detailedToolCall, loadToolDetail, toolDetailState } from "../toolDetailStore";
import { AskUser, AskUserReview } from "./AskUser";
import { Icon } from "./icons";
import { Button, IconButton, focusRingStyle } from "./primitives";
import { persistedToolState } from "./toolCards";

const metrics = designTokens.metrics.askUser;
const messageMetrics = designTokens.metrics.flowChat;

interface FollowUpState {
  draft: QuestionDraft;
  submitting: boolean;
  replies: QuestionReply[] | null;
  error: boolean;
}

// A reply and its draft survive virtual row disposal, the live/history handoff
// and split swaps. Only mounted, answerable timeouts create entries.
const followUps = new Map<string, Signal<FollowUpState>>();

function followUpState(key: string): Signal<FollowUpState> {
  let state = followUps.get(key);
  if (!state) {
    state = signal<FollowUpState>({ draft: {}, submitting: false, replies: null, error: false });
    followUps.set(key, state);
  }
  return state;
}

function QuestionReplyBubble(props: { id: string; replies: QuestionReply[] }) {
  return (
    <View testID={`question-reply-${props.id}`} style={{
      alignSelf: "flex-end",
      minWidth: 0,
      maxWidth: `${messageMetrics.userMessageWidthRatio * 100}%`,
      borderRadius: messageMetrics.userMessageRadius,
      borderCurve: "continuous",
      backgroundColor: palette().userBubble,
      paddingHorizontal: messageMetrics.userMessageRadius,
      paddingVertical: messageMetrics.userMessagePaddingBlock,
      gap: space.md,
    }}>
      <Each of={props.replies} key="index">
        {reply => <View style={{ minWidth: 0, gap: space.xs }}>
          <Text style={{ ...textStyle("smallBody", { color: palette().userBubbleText }), userSelect: "text" }}>
            {reply().question}
          </Text>
          <Each of={reply().values} key="index">
            {value => <Text style={{ ...textStyle("caption", { color: palette().textSecondary }), userSelect: "text" }}>
              {value()}
            </Text>}
          </Each>
        </View>}
      </Each>
    </View>
  );
}

function QuestionDisclosure(props: {
  id: string;
  label: string;
  open: boolean;
  onToggle?: () => void;
  children?: JSX.Element;
}) {
  return (
    <View style={{
      width: "100%", minWidth: 0, borderWidth: metrics.borderWidth, borderRadius: radii.lg,
      borderCurve: "continuous", borderColor: palette().borderSubtle,
      backgroundColor: designControlColors()?.toolCardSurface ?? palette().panelRaised,
    }}>
      <View testID={`question-result-${props.id}`} role={props.onToggle ? "button" : undefined}
        accessibilityLabel={props.label} accessibilityState={props.onToggle ? { expanded: props.open } : undefined}
        onPress={props.onToggle}
        style={{
          minHeight: compactLayout() ? layout.touchTarget : metrics.headerHeight - 2 * metrics.borderWidth,
          flexDirection: "row", alignItems: "center", paddingHorizontal: metrics.inlinePadding,
          gap: space.sm, borderRadius: radii.lg, cursor: props.onToggle ? "pointer" : undefined,
        }}
        hoverStyle={props.onToggle ? { backgroundColor: palette().panelHover } : undefined}
        focusVisibleStyle={props.onToggle ? focusRingStyle() : undefined}
      >
        <Icon name="help-circle" size={metrics.iconSize} color={palette().textSecondary} />
        <Text style={{ ...textStyle("smallBody"), minWidth: 0, flex: 1 }}>{props.label}</Text>
        <If when={Boolean(props.onToggle)}>
          <Icon name={props.open ? "chevron-up" : "chevron-down"} size={metrics.iconSize} color={palette().textMuted} />
        </If>
      </View>
      {props.children}
    </View>
  );
}

function TimedOutQuestion(props: {
  id: string;
  identity: string;
  open: boolean;
  onToggle: () => void;
  questions: QuestionView[];
  send: (message: string) => Promise<boolean>;
}) {
  const state = followUpState(props.identity);
  const submit = async (answers: QuestionAnswers) => {
    if (state().submitting || state().replies) return;
    const replies = questionReplies(props.questions, answers);
    if (replies.length !== props.questions.length) return;
    const message = replies.map(reply => [reply.question, ...reply.values].join("\n")).join("\n\n");
    state.update(current => ({ ...current, submitting: true, error: false }));
    try {
      const accepted = await props.send(message);
      state.update(current => ({ ...current, submitting: false, replies: accepted ? replies : null, error: !accepted }));
    } catch {
      state.update(current => ({ ...current, submitting: false, error: true }));
    }
  };

  return <If when={state().replies} else={
    <If when={props.open} else={
      <QuestionDisclosure id={props.id} label={tr("chat.question.timedOut")}
        open={false} onToggle={props.onToggle} />
    }>
      <AskUser id={`followup-${props.id}`} questions={props.questions} draft={state().draft}
        busy={state().submitting} submitting={state().submitting}
        title={tr("chat.question.timedOut")}
        submitLabel={tr("deviceJobs.followUp")}
        error={state().error ? tr("chat.question.followUpFailed") : undefined}
        trailing={<IconButton icon="chevron-up" size="xs" accessibilityLabel={tr("chat.question.collapse")}
          onPress={props.onToggle} />}
        onChange={update => state.update(current => ({ ...current, draft: update(current.draft), error: false }))}
        onSubmit={answers => void submit(answers)} />
    </If>
  }>
    {replies => <QuestionReplyBubble id={props.id} replies={replies()} />}
  </If>;
}

/** The host's terminal outcome of a question, shared by the live and durable transcripts. */
export function QuestionOutcomeCard(props: {
  call: ToolCallView;
  id: string;
  sessionKey: string | null;
  turnId: string;
  send: (sessionKey: string, message: string) => Promise<boolean>;
  fallback: JSX.Element;
}) {
  const open = signal(false);
  const toggle = () => open.update(value => !value);
  const detail = () => toolDetailState(props.call);
  const call = () => detailedToolCall(props.call);
  const result = computed(() => readQuestionResult(call().result));
  const questions = computed(() => readQuestions(call().input));
  const replies = computed(() => {
    if (detail() !== "whole" || persistedToolState(call()) !== "completed" ||
      ["timeout", "cancelled"].includes(String(result().status))) return [];
    const resultQuestions = readQuestions(result());
    return questionReplies(resultQuestions.length ? resultQuestions : questions(), result().answers);
  });
  const timedOut = () => result().status === "timeout";
  const cancelled = () => result().status === "cancelled" || persistedToolState(call()) === "cancelled";
  const cancelledLabel = () => call().status?.toLowerCase() === "rejected" ? tr("chat.tool.rejected") : tr("chat.tool.cancelled");
  const followUpKey = () => {
    const status = call().status?.toLowerCase();
    const interruption = call().interruptionReason?.toLowerCase();
    if (!timedOut() || !props.sessionKey || !props.turnId || !call().id || !questions().length ||
      persistedToolState(call()) !== "completed" || status === "superseded" || status === "retry_superseded" ||
      interruption === "retry_superseded") return "";
    return JSON.stringify([props.sessionKey, props.turnId, call().id]);
  };

  effect(() => {
    const preview = props.call;
    if (open() && preview.detailOmitted && untracked(() => toolDetailState(preview)) === "loading") {
      void loadToolDetail(preview);
    }
  });

  return (
    <If when={detail() !== "whole"} else={
      <If when={replies().length > 0} else={
        <If when={followUpKey()} else={
          <If when={timedOut() || cancelled()} else={props.fallback}>
            <QuestionDisclosure id={props.id}
              label={timedOut() ? tr("chat.question.timedOut") : cancelledLabel()}
              open={open()} onToggle={questions().length ? toggle : undefined}>
              <If when={open() && questions().length > 0}>
                <AskUserReview questions={questions()} />
              </If>
            </QuestionDisclosure>
          </If>
        }>
          {key => <Each of={[{ key: key(), sessionKey: props.sessionKey! }]} key={item => item.key}>
            {source => {
              const origin = source().sessionKey;
              return <TimedOutQuestion id={props.id} identity={source().key} open={open()} onToggle={toggle}
                questions={questions()} send={message => props.send(origin, message)} />;
            }}
          </Each>}
        </If>
      }>
        <QuestionReplyBubble id={props.id} replies={replies()} />
      </If>
    }>
      <QuestionDisclosure id={props.id} label={timedOut() ? tr("chat.question.timedOut") : tr("chat.question.viewResult")}
        open={open()} onToggle={toggle}>
        <If when={open()}>
          <View style={{ paddingHorizontal: metrics.inlinePadding, paddingBottom: metrics.bodyPadding, gap: space.sm }}>
            <Text style={textStyle("caption")}>{detail() === "failed" ? tr("chat.tool.detailFailed") : tr("common.loading")}</Text>
            <If when={detail() === "failed"}>
              <Button label={tr("common.retry")} size="sm" variant="secondary"
                onPress={() => void loadToolDetail(props.call)} />
            </If>
          </View>
        </If>
      </QuestionDisclosure>
    </If>
  );
}
