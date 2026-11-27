import { effect, signal, Text, View } from "nsh";
import { formatCount } from "../format";
import { localizeHostError, tr, type MessageKey } from "../i18n";
import { McpFormError, type McpFormAuth, type McpKeyValue, type McpTransport } from "../mcpServerForm";
import {
  canSaveMcpDraft, mcpBusy, mcpDraft, mcpDraftConflict, mcpDraftIsLegacySse, mcpDraftIssue, mcpDraftJson,
  switchMcpDraftEditor, updateMcpDraft, updateMcpDraftJson,
} from "../mcpStore";
import { space, textStyle } from "../theme";
import { ModalDialog, SelectDropdown } from "../ui/overlays";
import { Button, ConfigRow, IconButton, InlineBanner, InputBox, SegmentedTabs, ToggleSwitch } from "../ui/primitives";

const authLabels: Record<McpFormAuth, MessageKey> = {
  preserve: "settings.mcp.formAuthPreserve", auto: "settings.mcp.formAuthAuto", oauth: "settings.mcp.browserOAuth",
  token: "settings.mcp.formAuthToken", headers: "settings.mcp.headers",
};

function McpValues(props: { kind: "env" | "headers"; rows: McpKeyValue[]; readonly: boolean }) {
  const label = () => tr(props.kind === "env" ? "settings.mcp.env" : "settings.mcp.headers");
  const rowLabel = (field: MessageKey, index: number) => `${label()} · ${tr(field)} ${formatCount(index + 1)}`;
  const change = (index: number, patch: Partial<McpKeyValue>) =>
    updateMcpDraft({ [props.kind]: props.rows.map((entry, i) => i === index ? { ...entry, ...patch } : entry) });
  return <View style={{ gap: space.sm }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
      <Text style={textStyle("label")}>{label()}</Text>
      <Button label={tr("settings.mcp.formAddPair")} variant="secondary" size="sm" leadingIcon="plus" disabled={props.readonly}
        accessibilityLabel={`mcp-draft-${props.kind}-add`} onPress={() => updateMcpDraft({ [props.kind]: [...props.rows, { key: "", value: "" }] })} />
    </View>
    <Each of={props.rows.map((entry, index) => ({ entry, index }))} key={item => item.index}>{item =>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
        <InputBox value={item().entry.key} readonly={props.readonly} monospace size="sm"
          placeholder={tr("settings.mcp.formKey")} accessibilityLabel={`mcp-draft-${props.kind}-key-${item().index}`}
          accessibilityDescription={rowLabel("settings.mcp.formKey", item().index)}
          style={{ flex: 1, minWidth: 100 }} onChange={key => change(item().index, { key })} />
        <InputBox value={item().entry.value ?? ""} readonly={props.readonly} masked size="sm"
          placeholder={tr(item().entry.savedValue === undefined ? "settings.mcp.formValue" : "settings.mcp.formStoredValue")}
          accessibilityLabel={`mcp-draft-${props.kind}-value-${item().index}`}
          accessibilityDescription={rowLabel("settings.mcp.formValue", item().index)}
          style={{ flex: 2, minWidth: 110 }} onChange={value => change(item().index, { value })} />
        <IconButton icon="trash" size="sm" tooltip={tr("common.remove")} disabled={props.readonly}
          accessibilityLabel={`mcp-draft-${props.kind}-remove-${item().index}`}
          onPress={() => updateMcpDraft({ [props.kind]: props.rows.filter((_, i) => i !== item().index) })} />
      </View>}
    </Each>
  </View>;
}

export function McpServerEditor(props: { onClose: () => void; onReload: () => void; onSave: () => void }) {
  const open = () => Boolean(mcpDraft());
  const saving = () => mcpBusy() === "mcp-save";
  const busy = () => Boolean(mcpBusy());
  const raw = () => mcpDraftJson() !== null;
  const id = () => mcpDraft()?.originalId;
  const advanced = signal(false);
  const transportOptions = (): Array<{ value: McpTransport; label: string; accessibilityLabel: string }> => [
    { value: "streamable-http", label: "HTTP", accessibilityLabel: "mcp-draft-transport-streamable-http" },
    { value: "stdio", label: tr("settings.mcp.formLocalCommand"), accessibilityLabel: "mcp-draft-transport-stdio" },
    ...(mcpDraftIsLegacySse() ? [{ value: "sse" as const, label: "SSE", accessibilityLabel: "mcp-draft-transport-sse" }] : []),
  ];

  effect(() => { if (!open()) advanced.set(false); });
  effect(() => {
    const issue = mcpDraftIssue();
    if (issue instanceof McpFormError && (issue.field === "id" || issue.field === "startupSeconds")) advanced.set(true);
  });
  const issueLabel = () => {
    const issue = mcpDraftIssue();
    return issue instanceof McpFormError ? tr(issue.label) : issue ? localizeHostError(issue) : "";
  };
  const fieldError = (field: string) => {
    const issue = mcpDraftIssue();
    return issue instanceof McpFormError && issue.field === field ? tr(issue.label) : undefined;
  };
  const serverId = () => <InputBox label={tr("settings.mcp.serverId")} monospace value={mcpDraft()?.id ?? ""}
    placeholder={tr("settings.mcp.idFromNamePlaceholder")} readonly={id() !== undefined || busy()} error={fieldError("id")}
    accessibilityLabel="mcp-draft-id" onChange={value => updateMcpDraft({ id: value })} />;

  return <ModalDialog open={open()} size="lg" accessibilityLabel="mcp-draft-modal"
    title={id() === undefined ? tr("settings.mcp.newServerTitle") : tr("settings.mcp.editServerTitle", { id: id()! })}
    subtitle={tr("settings.mcp.serverModalSubtitle")} keepsInputOnClose closeOnBackdropPress={false} closeOnEscape={!busy()}
    onClose={props.onClose} footer={<View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, flex: 1 }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <If when={id() === undefined}><Text style={textStyle("caption")}>{tr("settings.mcp.storedDisabledHint")}</Text></If>
      </View>
      <Button label={tr("common.cancel")} variant="secondary" size="md" disabled={busy()} accessibilityLabel="mcp-draft-cancel" onPress={props.onClose} />
      <Button label={tr("common.save")} variant="primary" size="md" disabled={!canSaveMcpDraft()} loading={saving()}
        accessibilityLabel="mcp-draft-save" onPress={props.onSave} />
    </View>}>
    <If when={mcpDraft()}>{draft => <View style={{ gap: space.md }}>
      <If when={mcpDraftConflict()}><InlineBanner tone="warning" message={tr("settings.mcp.jsonConflict")}
        actionLabel={tr("settings.mcp.jsonReload")} onAction={props.onReload} /></If>
      <If when={issueLabel()}>{message => <InlineBanner tone="danger" message={message()} />}</If>
      <View style={{ alignItems: "flex-start" }}>
        <Button label={tr(raw() ? "settings.mcp.formBack" : "settings.mcp.formEditJson")} variant="secondary" size="sm" disabled={busy()}
          accessibilityLabel="mcp-draft-switch-editor" onPress={switchMcpDraftEditor} />
      </View>
      <If when={raw()} else={<>
        <InputBox label={tr("common.name")} value={draft().name} readonly={busy()} error={fieldError("name")}
          accessibilityLabel="mcp-draft-name" onChange={name => updateMcpDraft({ name })} />
        <View style={{ gap: space.xs }}>
          <Text style={textStyle("label")}>{tr("settings.mcp.transport")}</Text>
          <SegmentedTabs size="sm" scrollable value={draft().transport} options={transportOptions()}
            onChange={transport => updateMcpDraft({ transport })} />
        </View>
        <If when={draft().transport === "stdio"} else={<>
          <InputBox label={tr("settings.mcp.serverUrl")} monospace value={draft().url} readonly={busy()} error={fieldError("url")}
            placeholder="https://host/mcp" accessibilityLabel="mcp-draft-url" onChange={url => updateMcpDraft({ url })} />
          <ConfigRow label={tr("settings.mcp.formAuth")} divider={false}>
            <SelectDropdown size="sm" value={draft().auth} disabled={busy()} accessibilityLabel="mcp-draft-auth"
              options={(Object.keys(authLabels) as McpFormAuth[]).filter(auth => auth !== "preserve" || draft().auth === "preserve" || id() !== undefined)
                .map(value => ({ value, label: tr(authLabels[value]), accessibilityLabel: `mcp-draft-auth-${value}` }))}
              onChange={auth => updateMcpDraft({ auth })} />
          </ConfigRow>
          <If when={draft().auth === "token"}>
            <InputBox label={tr("settings.mcp.formAuthToken")} masked value={draft().token} readonly={busy()} error={fieldError("token")}
              accessibilityLabel="mcp-draft-token" onChange={token => updateMcpDraft({ token })} />
          </If>
          <If when={draft().auth === "headers" || (draft().auth === "preserve" && draft().headers.length > 0)}>
            <McpValues kind="headers" rows={draft().headers} readonly={busy()} />
          </If>
        </>}>
          <InputBox label={tr("settings.mcp.command")} monospace value={draft().command} readonly={busy()} error={fieldError("command")}
            placeholder={tr("settings.mcp.commandPlaceholder")} accessibilityLabel="mcp-draft-command" onChange={command => updateMcpDraft({ command })} />
          <View style={{ gap: space.sm }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
              <Text style={textStyle("label")}>{tr("settings.mcp.args")}</Text>
              <Button label={tr("settings.mcp.formAddArgument")} variant="secondary" size="sm" leadingIcon="plus" disabled={busy()}
                accessibilityLabel="mcp-draft-arg-add" onPress={() => updateMcpDraft({ args: [...draft().args, ""] })} />
            </View>
            <Each of={draft().args.map((value, index) => ({ value, index }))} key={arg => arg.index}>{arg =>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
                <InputBox monospace size="sm" value={arg().value} readonly={busy()} style={{ flex: 1, minWidth: 0 }}
                  accessibilityLabel={`mcp-draft-arg-${arg().index}`} onChange={value => updateMcpDraft({
                    args: draft().args.map((existing, index) => index === arg().index ? value : existing),
                  })} />
                <IconButton icon="trash" size="sm" tooltip={tr("common.remove")} disabled={busy()}
                  accessibilityLabel={`mcp-draft-arg-remove-${arg().index}`}
                  onPress={() => updateMcpDraft({ args: draft().args.filter((_, index) => index !== arg().index) })} />
              </View>}
            </Each>
          </View>
          <McpValues kind="env" rows={draft().env} readonly={busy()} />
        </If>
        <View style={{ alignItems: "flex-start" }}>
          <Button label={tr("settings.mcp.formAdvanced")} variant="ghost" size="sm" leadingIcon={advanced() ? "chevron-down" : "chevron-right"}
            accessibilityLabel="mcp-draft-advanced" disabled={busy()} onPress={() => advanced.update(open => !open)} />
        </View>
        <If when={advanced()}>
          {serverId()}
          <If when={draft().transport === "stdio"}><InputBox label={tr("settings.mcp.cwd")} monospace value={draft().workingDirectory} readonly={busy()}
            accessibilityLabel="mcp-draft-cwd" onChange={workingDirectory => updateMcpDraft({ workingDirectory })} /></If>
          <InputBox label={tr("settings.mcp.startupTimeout")} value={draft().startupSeconds} readonly={busy()} error={fieldError("startupSeconds")}
            placeholder={tr("settings.mcp.startupSecondsPlaceholder")} accessibilityLabel="mcp-draft-startup"
            onChange={startupSeconds => updateMcpDraft({ startupSeconds })} />
          <ConfigRow label={tr("settings.mcp.startsWithApp")} divider={id() !== undefined}>
            <ToggleSwitch value={draft().autoStart} disabled={busy()} accessibilityLabel="mcp-draft-autostart" onChange={autoStart => updateMcpDraft({ autoStart })} />
          </ConfigRow>
          <If when={id() !== undefined}><ConfigRow label={tr("common.enabled")} divider={false}>
            <ToggleSwitch value={draft().enabled} disabled={busy()} accessibilityLabel="mcp-draft-enabled" onChange={enabled => updateMcpDraft({ enabled })} />
          </ConfigRow></If>
        </If>
      </>}>
        {serverId()}
        <InputBox label={tr("settings.mcp.formEditJson")} multiline monospace minHeight={280} value={mcpDraftJson() ?? ""} readonly={busy()}
          accessibilityLabel="mcp-draft-json" onChange={updateMcpDraftJson} />
        <Text style={textStyle("caption")}>{tr("settings.mcp.formJsonHint")}</Text>
      </If>
    </View>}</If>
  </ModalDialog>;
}
