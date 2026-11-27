import { cleanup, computed, Scroll, signal, Text, View } from "nsh";
import { localizeHostError, tr } from "../i18n";
import { isAutomaticReasoning, reasoningEffort, reasoningPresetLabel, type ReasoningChoice } from "../modelStore";
import { palette, radii, space, textStyle } from "../theme";
import { Icon } from "./icons";
import { ListRowContent } from "./overlays";
import { focusRingStyle, InlineBanner, SegmentedTabs } from "./primitives";

function equivalence(preset: ReasoningChoice): string {
  const effort = reasoningEffort(preset);
  if (preset.source !== "model_config") {
    if (effort === "off" || effort === "none") return "effort:off";
    if (preset.effective_effort) return `effort:${preset.effective_effort}`;
  }
  return `preset:${preset.id}`;
}

interface Option { value: string; preset: string | null; label: string; accessibilityLabel: string }

function presentation(choices: ReasoningChoice[], selectedId: string | null) {
  const groups = new Map<string, ReasoningChoice>();
  for (const choice of choices) {
    const key = equivalence(choice);
    const canonical = choice.effective_effort && choice.actions.some(action => action.type === "effort" && action.value === choice.effective_effort);
    if (!groups.has(key) || canonical) groups.set(key, choice);
  }
  const presets = [...groups.values()];
  const hasIntensity = presets.some(choice => ["minimal", "low", "medium", "high", "xhigh", "max"].includes(reasoningEffort(choice) ?? "")
    || choice.actions.some(action => action.type === "budget_tokens"));
  const automaticChoices = presets.filter(isAutomaticReasoning);
  const autoChoice = automaticChoices.find(choice => reasoningEffort(choice) !== "on") ?? (hasIntensity ? undefined : automaticChoices[0]);
  const options: Option[] = [{ value: "auto", preset: autoChoice?.id ?? null, label: tr("common.auto"), accessibilityLabel: "reasoning-option-default" }];
  for (const choice of presets) {
    if (!isAutomaticReasoning(choice)) options.push({ value: equivalence(choice), preset: choice.id, label: reasoningPresetLabel(choice),
      accessibilityLabel: `reasoning-option-${choice.id}` });
  }
  const selected = choices.find(choice => choice.id === selectedId);
  const value = selected ? isAutomaticReasoning(selected) ? "auto" : equivalence(selected) : selectedId === null ? "auto" : "";
  return { options, value, label: options.find(option => option.value === value)?.label ?? selectedId ?? tr("common.auto") };
}

export function ReasoningControl(props: {
  choices: ReasoningChoice[];
  selected: string | null;
  pending: boolean;
  expandable?: boolean;
  onSelect: (preset: string | null) => Promise<boolean>;
  onConfirmed?: () => void;
}) {
  const config = computed(() => presentation(props.choices, props.selected));
  const expanded = signal(!props.expandable);
  const error = signal("");
  let mounted = true;
  cleanup(() => { mounted = false; });

  async function select(value: string): Promise<void> {
    const option = config().options.find(candidate => candidate.value === value);
    if (!option || props.pending) return;
    error.set("");
    try {
      if (!(await props.onSelect(option.preset))) {
        if (mounted) error.set(tr("sessions.reasoningUnavailable"));
        return;
      }
      if (!mounted) return;
      if (props.expandable) expanded.set(false);
      props.onConfirmed?.();
    } catch (reason) {
      if (mounted) error.set(localizeHostError(reason));
    }
  }

  return <View style={{ gap: space.xs }}>
    <If when={props.expandable}>
      <View role="button" accessibilityLabel="model-picker-reasoning" accessibilityState={{ expanded: expanded(), busy: props.pending }}
        onPress={() => expanded.set(!expanded())} onKeyDown={event => {
          if (event.key === "ArrowRight") expanded.set(true);
        }}
        style={{ paddingVertical: space.xs, paddingHorizontal: space.sm, borderRadius: radii.sm }}
        hoverStyle={{ backgroundColor: palette().panelHover }} focusVisibleStyle={focusRingStyle()}>
        <ListRowContent title={tr("sessions.reasoning")} trailing={<View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
          <Text style={textStyle("caption", { color: palette().textMuted })}>{config().label}</Text>
          <Icon name={expanded() ? "chevron-down" : "chevron-right"} size={12} color={palette().textMuted} />
        </View>} />
      </View>
    </If>
    <If when={expanded()}>
      <Scroll smoothWheel style={{ maxHeight: 208, minHeight: 0 }}>
        <SegmentedTabs options={config().options} value={config().value} size="sm" wrap disabled={props.pending}
          interaction="buttons" accessibilityLabel="reasoning-preset-segments" onChange={value => void select(value)} />
      </Scroll>
      <If when={error()}>{message => <InlineBanner tone="warning" message={message()} />}</If>
    </If>
  </View>;
}
