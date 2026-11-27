import { Scroll, Text, View, signal, type JSX } from "nsh";
import { formatCount } from "../format";
import { designTokens } from "../generated/designTokens";
import { tr } from "../i18n";
import {
  buildQuestionAnswers, hasQuestionAnswer, pickQuestionOption, questionSelection,
  type QuestionAnswers, type QuestionDraft, type QuestionView,
} from "../questionDraft";
import { compactLayout, controlHeight, designControlColors, layout, palette, radii, space, textStyle } from "../theme";
import { ChoiceIndicator } from "./ChoiceIndicator";
import { Icon } from "./icons";
import { MOTION_DURATION, paintTransition } from "./motion";
import { Button, InputBox, focusRingStyle } from "./primitives";

const metrics = designTokens.metrics.askUser;

interface AskUserProps {
  id: string;
  questions: QuestionView[];
  draft: QuestionDraft;
  busy?: boolean;
  submitting?: boolean;
  leading?: JSX.Element;
  trailing?: JSX.Element;
  error?: string;
  title?: string;
  submitLabel?: string;
  onChange: (update: (draft: QuestionDraft) => QuestionDraft) => void;
  onSubmit: (answers: QuestionAnswers) => void;
}

export function AskUserReview(props: { questions: QuestionView[] }) {
  return (
    <View style={{ paddingHorizontal: metrics.inlinePadding, paddingVertical: metrics.bodyPadding, gap: space.md }}>
      <Each of={props.questions} key="index">
        {(question, questionIndex) => (
          <View style={{ gap: metrics.optionGap }}>
            <Text style={{ ...textStyle("smallBody"), fontWeight: "600" }}>{question().question || question().header}</Text>
            <Each of={question().options} key="index">
              {(option, optionIndex) => <AskUserOption id={`question-review-${questionIndex()}-${optionIndex()}`}
                label={option().label} description={option().description}
                multiple={question().multiSelect} selected={false} busy onPress={() => undefined} />}
            </Each>
          </View>
        )}
      </Each>
    </View>
  );
}

function AskUserOption(props: {
  id: string;
  label: string;
  description?: string;
  multiple: boolean;
  selected: boolean;
  busy?: boolean;
  onPress: () => void;
  children?: JSX.Element;
}) {
  return (
    <View
      style={{ minWidth: 0, borderRadius: radii.lg, backgroundColor: palette().surfaceSubtle, ...paintTransition(MOTION_DURATION.fast) }}
      hoverStyle={props.busy ? undefined : { backgroundColor: palette().panelHover }}
    >
      <View
        role={props.multiple ? "checkbox" : "radio"}
        testID={props.id}
        accessibilityLabel={props.label}
        accessibilityHint={props.description}
        accessibilityState={{ checked: props.selected, disabled: Boolean(props.busy) }}
        disabled={props.busy}
        onPress={props.onPress}
        style={{
          minHeight: compactLayout() ? layout.touchTarget : controlHeight.sm,
          minWidth: 0,
          flexDirection: "row",
          alignItems: "flex-start",
          gap: space.sm,
          paddingHorizontal: metrics.optionPaddingInline,
          paddingVertical: metrics.optionPaddingBlock,
          borderRadius: radii.lg,
          cursor: props.busy ? "default" : "pointer",
        }}
        focusVisibleStyle={focusRingStyle()}
      >
        <ChoiceIndicator kind={props.multiple ? "checkbox" : "radio"} size={props.multiple ? "lg" : "md"}
          checked={props.selected} disabled={props.busy} style={{ marginTop: space.hair }} />
        <View style={{ flex: 1, minWidth: 0, gap: metrics.optionContentGap }}>
          <Text style={textStyle("smallBody")}>{props.label}</Text>
          <If when={props.description ?? ""}>
            {description => <Text style={textStyle("smallBody", { color: palette().textMuted })}>{description()}</Text>}
          </If>
        </View>
      </View>
      {props.children}
    </View>
  );
}

/** NSH rendition of the design system's AskUser form. The caller owns delivery and draft lifetime. */
export function AskUser(props: AskUserProps) {
  const page = signal(0);
  const total = () => props.questions.length;
  const index = () => Math.max(0, Math.min(page(), total() - 1));
  const active = () => props.questions[index()];
  const selection = () => questionSelection(props.draft, index());
  const hasNext = () => index() < total() - 1;
  const canAdvance = () => {
    const question = active();
    return question !== undefined && hasQuestionAnswer(question, props.draft, index());
  };
  const answers = () => buildQuestionAnswers(props.questions, props.draft);
  const selectedCount = () => selection().labels.length + Number(selection().custom);
  const prefix = () => `question-${props.id}-${index()}`;
  const pick = (label: string | null) => {
    const question = active();
    const current = index();
    if (question && !props.busy) {
      props.onChange(draft => pickQuestionOption(draft, current, question.multiSelect, label));
    }
  };
  const changeOther = (text: string) => {
    const current = index();
    if (!props.busy) {
      props.onChange(draft => ({ ...draft, [current]: { ...questionSelection(draft, current), text } }));
    }
  };
  const advance = () => {
    if (props.busy) return;
    if (hasNext()) {
      if (canAdvance()) page.set(index() + 1);
      return;
    }
    const payload = answers();
    if (payload) props.onSubmit(payload);
  };

  return (
    <View
      testID={`question-card-${props.id}`}
      style={{
        width: "100%",
        minWidth: 0,
        borderWidth: metrics.borderWidth,
        borderColor: palette().borderSubtle,
        borderRadius: radii.lg,
        borderCurve: "continuous",
        backgroundColor: designControlColors()?.toolCardSurface ?? palette().panelRaised,
        overflow: "hidden",
      }}
    >
      <View style={{
        minHeight: compactLayout() ? layout.touchTarget : metrics.headerHeight - 2 * metrics.borderWidth,
        flexDirection: "row",
        alignItems: "center",
        gap: space.sm,
        paddingHorizontal: metrics.inlinePadding,
        borderBottomWidth: metrics.borderWidth,
        borderColor: palette().borderSubtle,
      }}>
        <Icon name="help-circle" size={metrics.iconSize} color={palette().text} />
        {props.leading}
        <If when={total() > 1} else={
          <Text style={{ ...textStyle("smallBody"), flex: 1, minWidth: 0, fontWeight: "600" }}>
            {props.title ?? tr("sessions.questionTitle")}
          </Text>
        }>
          <Text style={{ ...textStyle("smallBody", { tabular: true }), fontWeight: "600" }}>
            {`${formatCount(index() + 1)}/${formatCount(total())}`}
          </Text>
          <Text style={{ ...textStyle("smallBody", { color: palette().textSecondary }), flex: 1, minWidth: 0, numberOfLines: 1 }}>
            {active()?.header || props.title || tr("sessions.questionTitle")}
          </Text>
        </If>
        {props.trailing}
        <If when={index() > 0}>
          <Button label={tr("common.back")} leadingIcon="arrow-left" size="sm" variant="secondary"
            accessibilityLabel={tr("chat.question.previous")} testID={`question-prev-${props.id}`}
            disabled={props.busy} onPress={() => page.set(index() - 1)}
            style={compactLayout() ? { minHeight: layout.touchTarget } : undefined} />
        </If>
      </View>
      <If when={total() > 1}>
        <View style={{ height: metrics.borderWidth, backgroundColor: palette().surfaceSubtle }}>
          <View style={{ height: metrics.borderWidth, width: `${(index() + 1) / total() * 100}%`, backgroundColor: palette().textSecondary }} />
        </View>
      </If>
      <Each of={active() ? [active()!] : []} key={() => index()}>
        {question => (
          <Scroll smoothWheel scrollbar={true} style={{ maxHeight: 340, minHeight: 0 }}>
            <View style={{ gap: metrics.questionOptionsGap, paddingHorizontal: metrics.inlinePadding, paddingVertical: metrics.bodyPadding }}>
              <Text style={{ ...textStyle("smallBody"), fontWeight: "600" }}>
                {question().question || question().header}
              </Text>
              <View style={{ gap: metrics.optionGap }}>
                <Each of={question().options} key="index">
                  {option => (
                    <AskUserOption id={`${prefix()}-${option().label}`} label={option().label} description={option().description}
                      multiple={question().multiSelect} selected={selection().labels.includes(option().label)}
                      busy={props.busy} onPress={() => pick(option().label)} />
                  )}
                </Each>
                <AskUserOption id={`${prefix()}-other`} label={tr("sessions.questionOther")}
                  description={selection().custom ? undefined : tr("sessions.questionOtherDetail")}
                  multiple={question().multiSelect} selected={selection().custom} busy={props.busy}
                  onPress={() => pick(null)}>
                  <If when={selection().custom}>
                    <View
                      style={{
                        paddingLeft: metrics.optionPaddingInline + 16 + space.sm,
                        paddingRight: metrics.optionPaddingInline,
                        paddingBottom: metrics.optionPaddingBlock,
                      }}
                    >
                      <InputBox autoFocus size="sm" testID={`${prefix()}-text`} accessibilityLabel={tr("sessions.questionPlaceholder")}
                        placeholder={tr("sessions.questionPlaceholder")} value={selection().text}
                        disabled={props.busy} onChange={changeOther} onSubmit={advance} />
                    </View>
                  </If>
                </AskUserOption>
              </View>
            </View>
          </Scroll>
        )}
      </Each>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm,
        paddingHorizontal: metrics.inlinePadding, paddingBottom: metrics.bodyPadding }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <If when={props.error ?? ""} else={
            <If when={active()?.multiSelect}>
              <Text style={textStyle("caption")}>
                {selectedCount() > 0
                  ? tr("chat.question.selectedCount", {
                    selected: formatCount(selectedCount()),
                    total: formatCount((active()?.options.length ?? 0) + 1),
                  })
                  : tr("sessions.questionChooseMulti")}
              </Text>
            </If>
          }>
            {message => <Text style={textStyle("caption", { color: palette().danger })}>{message()}</Text>}
          </If>
        </View>
        <Button
          label={hasNext() ? tr("chat.question.next") : props.submitting ? tr("common.sending") : props.submitLabel ?? tr("sessions.sendAnswer")}
          testID={hasNext() ? `question-next-${props.id}` : `question-send-${props.id}`}
          variant="primary"
          size="sm"
          loading={props.submitting}
          disabled={props.busy || (hasNext() ? !canAdvance() : !answers())}
          style={compactLayout() ? { minHeight: layout.touchTarget } : undefined}
          onPress={advance}
        />
      </View>
    </View>
  );
}
