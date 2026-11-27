import { Text, View } from "nsh";
import { localizeHostError, tr } from "../i18n";
import {
  canSaveMcpJson, mcpBusy, mcpDocumentLoaded, mcpJsonConflict, mcpJsonDirty, mcpJsonNotice,
  mcpJsonText, mcpJsonValidation, mcpJsonWritable, updateMcpJson,
} from "../mcpStore";
import { space, textStyle } from "../theme";
import { Button, InlineBanner, InputBox } from "../ui/primitives";

export function McpJsonEditor(props: { onClose: () => void; onReload: () => void; onSave: () => void }) {
  const saving = () => mcpBusy() === "mcp-json";
  const validationMessage = () => {
    const issue = mcpJsonValidation();
    if (!issue || !mcpJsonWritable()) return undefined;
    return "syntax" in issue ? tr("settings.mcp.jsonInvalid", { error: issue.syntax }) : tr("settings.mcp.jsonMissingServers");
  };

  return <View accessibilityLabel="mcp-json-editor" style={{ gap: space.md, padding: space.lg }}>
    <View style={{ gap: space.xs }}>
      <Text role="header" style={textStyle("label")}>{tr("settings.mcp.jsonEditorTitle")}</Text>
      <Text style={textStyle("caption")}>{tr("settings.mcp.jsonEditorDescription")}</Text>
    </View>
    <If when={!mcpDocumentLoaded()}><Text style={textStyle("caption")}>{tr("common.loading")}</Text></If>
    <If when={mcpJsonConflict()}>
      <InlineBanner tone="warning" message={tr("settings.mcp.jsonConflict")}
        actionLabel={tr("settings.mcp.jsonReload")} onAction={props.onReload} />
    </If>
    <If when={mcpDocumentLoaded() && !mcpJsonWritable() && !mcpJsonConflict()}>
      <InlineBanner tone="warning" message={tr("settings.mcp.jsonUnavailable")}
        actionLabel={tr("settings.mcp.jsonReload")} onAction={props.onReload} />
    </If>
    <If when={mcpJsonNotice()}>{notice => <InlineBanner tone="danger" message={localizeHostError(notice())} />}</If>
    <InputBox multiline monospace minHeight={300} value={mcpJsonText()} accessibilityLabel="mcp-json"
      readonly={!mcpJsonWritable() || saving()} error={validationMessage()} onChange={updateMcpJson}
      onKeyPress={event => { if (event.key === "Escape") props.onClose(); }} />
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
      <Text style={{ ...textStyle("caption"), flex: 1, minWidth: 0 }}>
        {saving() ? tr("common.saving") : mcpJsonConflict() || mcpJsonNotice() ? tr("settings.mcp.jsonNotSaved")
          : mcpJsonDirty() ? tr("settings.unsaved.title") : mcpJsonWritable() ? tr("common.saved") : ""}
      </Text>
      <Button label={tr("common.cancel")} variant="secondary" size="md" disabled={saving()}
        accessibilityLabel="mcp-json-cancel" onPress={props.onClose} />
      <Button label={tr("settings.mcp.saveJson")} variant="primary" size="md" loading={saving()}
        disabled={!canSaveMcpJson()} accessibilityLabel="mcp-json-save" onPress={props.onSave} />
    </View>
  </View>;
}
