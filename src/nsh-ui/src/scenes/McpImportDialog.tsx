import { Text, View } from "nsh";
import { localizeHostError, tr } from "../i18n";
import {
  canImportMcpServers, mcpBusy, mcpImportCandidates, mcpImportConflict, mcpImportFileName, mcpImportIssue, mcpImportNotice,
  mcpImportOpen, mcpImportReading, mcpImportTargetIssues, mcpImportText, pickMcpImportFile, previewMcpImport,
  reloadMcpImportTarget, setMcpImportText, updateMcpImportCandidate, type McpImportCandidate,
} from "../mcpStore";
import { space, textStyle } from "../theme";
import { ChoiceCheckbox } from "../ui/ChoiceIndicator";
import { ModalDialog } from "../ui/overlays";
import { Button, ConfigRow, ConfigSection, InlineBanner, InputBox } from "../ui/primitives";

function importBusy(): boolean {
  return mcpImportReading() || Boolean(mcpBusy());
}

function CandidateRow(props: { candidate: McpImportCandidate; first: boolean }) {
  const row = () => props.candidate;
  const targetIssue = () => mcpImportTargetIssues().get(row().sourceId);
  return <ConfigRow label={row().sourceId} description={row().unsupported ? tr(row().unsupported!) : undefined}
    divider={false} topDivider={!props.first} controlWidth={240} wrap>
    <InputBox size="sm" monospace value={row().targetId} readonly={Boolean(row().unsupported) || importBusy()}
      accessibilityLabel={`mcp-import-target-${row().sourceId}`} placeholder={tr("settings.mcp.serverId")}
      error={targetIssue() ? tr(targetIssue()!) : undefined} style={{ flex: 1, minWidth: 0 }}
      onChange={targetId => updateMcpImportCandidate(row().sourceId, { targetId })} />
    <ChoiceCheckbox checked={row().selected} disabled={Boolean(row().unsupported) || importBusy()}
      accessibilityLabel={`mcp-import-select-${row().sourceId}`} onChange={selected => updateMcpImportCandidate(row().sourceId, { selected })} />
  </ConfigRow>;
}

export function McpImportDialog(props: { onClose: () => void; onSave: () => void }) {
  const issue = () => mcpImportIssue();
  return <ModalDialog open={mcpImportOpen()} title={tr("settings.mcp.importTitle")} subtitle={tr("settings.mcp.importSubtitle")}
    size="lg" accessibilityLabel="mcp-import-modal" keepsInputOnClose closeOnBackdropPress={false} closeOnEscape={!importBusy()}
    onClose={props.onClose} footer={<View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, alignItems: "center", flex: 1 }}>
      <Text style={{ ...textStyle("caption"), flex: 1, minWidth: 0 }}>{tr("settings.mcp.importDisabledHint")}</Text>
      <Button label={tr("common.cancel")} variant="secondary" size="md" accessibilityLabel="mcp-import-close"
        disabled={importBusy()} onPress={props.onClose} />
      <Button label={tr("settings.mcp.importSelected")} variant="primary" size="md" accessibilityLabel="mcp-import-save"
        disabled={!canImportMcpServers()} loading={mcpBusy() === "mcp-import"} onPress={props.onSave} />
    </View>}>
    <View style={{ gap: space.md }}>
      <If when={mcpImportConflict()}>
        <InlineBanner tone="warning" message={tr("settings.mcp.importConflict")}
          actionLabel={tr("settings.mcp.importReloadTarget")} onAction={() => void reloadMcpImportTarget()} />
      </If>
      <If when={issue()}>{value => <InlineBanner tone="warning" message={tr(value())} />}</If>
      <If when={mcpImportNotice()}>{message => <InlineBanner tone="danger" message={localizeHostError(message())} />}</If>
      <InputBox label={tr("settings.mcp.importSource")} multiline monospace minHeight={168} value={mcpImportText()}
        readonly={importBusy()} placeholder={'{\n  "mcpServers": {}\n}'} accessibilityLabel="mcp-import-text" onChange={setMcpImportText} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
        <Button label={tr("configTransfer.chooseFile")} variant="secondary" size="sm" accessibilityLabel="mcp-import-pick"
          disabled={importBusy()} onPress={() => void pickMcpImportFile()} />
        <Button label={tr("common.preview")} variant="secondary" size="sm" accessibilityLabel="mcp-import-preview"
          disabled={importBusy() || !mcpImportText().trim()} onPress={previewMcpImport} />
        <If when={mcpImportReading()} else={<If when={mcpImportFileName()}>
          {name => <Text style={{ ...textStyle("caption"), flex: 1, minWidth: 120 }}>{name()}</Text>}
        </If>}>
          <Text style={textStyle("caption")}>{tr("common.loading")}</Text>
        </If>
      </View>
      <If when={mcpImportCandidates()?.length}>
        <View accessibilityLabel="mcp-import-review">
          <ConfigSection title={tr("settings.mcp.importReview")} flush>
            <Each of={mcpImportCandidates() ?? []} key={candidate => candidate.sourceId}>
              {(candidate, index) => <CandidateRow candidate={candidate()} first={index() === 0} />}
            </Each>
          </ConfigSection>
        </View>
      </If>
    </View>
  </ModalDialog>;
}
