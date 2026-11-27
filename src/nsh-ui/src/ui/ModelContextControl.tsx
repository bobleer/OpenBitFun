import { cleanup, signal, Text, View } from "nsh";
import { formatCount, formatTokens } from "../format";
import { localizeHostError, tr } from "../i18n";
import { modelContextPending, saveComposerModelContext, type ModelContextView } from "../modelStore";
import { palette, radii, space, textStyle } from "../theme";
import { Icon } from "./icons";
import { ListRowContent } from "./overlays";
import { Button, focusRingStyle, IconButton, InlineBanner, InputBox } from "./primitives";

const MIN_CONTEXT = 32_000;
const MAX_CONTEXT = 2_000_000;

export function ModelContextControl(props: {
  model: ModelContextView;
  reportedWindow?: number | null;
  editing: boolean;
  disabled: boolean;
  onEditingChange: (key: string | null) => void;
}) {
  const draft = signal("");
  const error = signal("");
  const outputClamped = signal(false);
  const selectedWindow = () => props.model.contextWindow ?? props.reportedWindow;
  const pending = () => modelContextPending(props.model);
  const editDisabled = () => props.disabled || pending() || !props.model.editable;
  let mounted = true;
  cleanup(() => { mounted = false; });

  const edit = () => {
    if (editDisabled()) return;
    draft.set(String(selectedWindow() || 300_000));
    error.set("");
    outputClamped.set(false);
    props.onEditingChange(props.model.key);
  };

  async function save(): Promise<void> {
    if (editDisabled() || !props.editing) return;
    const value = draft().trim();
    const tokens = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(tokens) || tokens < MIN_CONTEXT || tokens > MAX_CONTEXT) {
      error.set(tr("sessions.modelContextRange", { min: formatCount(MIN_CONTEXT), max: formatCount(MAX_CONTEXT) }));
      return;
    }

    const model = props.model;
    error.set("");
    try {
      const result = await saveComposerModelContext(model, tokens);
      if (!mounted || props.model.key !== model.key) return;
      outputClamped.set(result.outputClamped);
      props.onEditingChange(null);
    } catch (reason) {
      if (mounted && props.model.key === model.key) error.set(localizeHostError(reason));
    }
  }

  return <View style={{ gap: space.xs }}>
    <If when={props.editing} else={<View role="button" accessibilityLabel="model-picker-context"
      accessibilityState={{ disabled: editDisabled(), expanded: false }}
      disabled={editDisabled()} onPress={edit} onKeyDown={event => { if (event.key === "ArrowRight") edit(); }}
      tooltip={props.model.editable ? undefined : tr("sessions.modelContextReadOnly")}
      style={{ paddingVertical: space.xs, paddingHorizontal: space.sm, borderRadius: radii.sm }}
      hoverStyle={editDisabled() ? undefined : { backgroundColor: palette().panelHover }} focusVisibleStyle={focusRingStyle()}>
      <ListRowContent title={tr("settings.models.contextWindow")} trailing={<View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
        <Text style={textStyle("caption", { color: palette().textMuted })}>
          {selectedWindow() ? formatTokens(selectedWindow()!) : tr("sessions.modelContextUnknown")}
        </Text>
        <If when={props.model.editable}><Icon name="chevron-right" size={12} color={palette().textMuted} /></If>
      </View>} />
    </View>}>
      <View style={{ gap: space.sm, paddingVertical: space.xs, paddingHorizontal: space.sm }}>
        <Text style={textStyle("label")}>{tr("settings.models.contextWindow")}</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
          <InputBox value={draft()} size="sm" content="number" autoFocus disabled={editDisabled()} error={error()}
            accessibilityLabel="model-picker-context-input" onChange={value => { draft.set(value); error.set(""); }}
            onSubmit={() => void save()} style={{ flex: 1 }} />
          <Button label={tr("common.save")} size="xs" variant="primary" accessibilityLabel="model-picker-context-save"
            disabled={editDisabled()} loading={pending()} onPress={() => void save()} />
          <IconButton icon="close" size="xs" tooltip={tr("common.cancel")} accessibilityLabel="model-picker-context-cancel"
            disabled={pending()} onPress={() => props.onEditingChange(null)} />
        </View>
      </View>
    </If>
    <If when={outputClamped() && !props.editing}>
      <InlineBanner tone="warning" message={tr("settings.models.outputClamped")} />
    </If>
  </View>;
}
