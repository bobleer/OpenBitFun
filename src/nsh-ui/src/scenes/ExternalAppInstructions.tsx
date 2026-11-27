import { cleanup, computed, effect, signal, Text, untracked, View } from "nsh";
import { invokeCommand } from "../bridge";
import { isCommandMissing, workspaceFields } from "../externalImportStore";
import { tr } from "../i18n";
import { skillsCatalogContextKey } from "../skillsCatalogStore";
import { activeWorkspace } from "../state";
import { space, textStyle } from "../theme";
import { ModalDialog } from "../ui/overlays";
import { Badge, Button, ConfigRow, ConfigSection, InlineBanner } from "../ui/primitives";

interface InstructionSource {
  ecosystemId: string;
  name: string;
  path: string;
  scope: "user" | "project";
  pathPatterns: string[];
}

interface InstructionCatalog {
  schemaVersion: number;
  entries: InstructionSource[];
  failedEcosystems: string[];
}

type CatalogState =
  | { kind: "loading" | "error" | "unsupported" }
  | { kind: "ready"; catalog: InstructionCatalog };

const command = "get_instruction_source_catalog";

function readCatalog(value: InstructionCatalog): InstructionCatalog {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.failedEcosystems)
    || !value.failedEcosystems.every(id => typeof id === "string")
    || !Array.isArray(value.entries) || !value.entries.every(entry => entry
      && typeof entry.ecosystemId === "string" && typeof entry.name === "string" && typeof entry.path === "string"
      && (entry.scope === "user" || entry.scope === "project") && Array.isArray(entry.pathPatterns)
      && entry.pathPatterns.every(pattern => typeof pattern === "string"))) {
    throw new Error("invalid_response");
  }
  return value;
}

function sourceId(source: InstructionSource): string {
  return JSON.stringify([source.ecosystemId, source.scope, source.path]);
}

function scopeLabel(source: InstructionSource): string {
  return tr(source.scope === "project" ? "settings.externalImports.scope.project" : "settings.externalImports.scope.user");
}

function applicationLabel(source: InstructionSource): string {
  return tr(source.pathPatterns.length > 0 ? "settings.externalImports.instructions.conditional" : "settings.externalImports.instructions.startup");
}

export function ExternalAppInstructions(props: { ecosystemId: string; refreshVersion: number }) {
  const result = signal<{ scope: string; state: CatalogState } | null>(null);
  const detail = signal<InstructionSource | null>(null);
  const state = () => {
    const response = result();
    return response?.scope === skillsCatalogContextKey() ? response.state : null;
  };
  let loadTicket = 0;
  async function load(forceRefresh: boolean) {
    const scope = skillsCatalogContextKey();
    const ticket = ++loadTicket;
    const publish = (state: CatalogState) => {
      if (ticket === loadTicket && scope === skillsCatalogContextKey()) result.set({ scope, state });
    };
    publish({ kind: "loading" });
    try {
      const response = await invokeCommand<InstructionCatalog>(command, { ...workspaceFields(activeWorkspace()), forceRefresh });
      publish({ kind: "ready", catalog: readCatalog(response) });
    } catch (error) {
      publish({ kind: isCommandMissing(command, error) ? "unsupported" : "error" });
    }
  }
  let lastRefresh = props.refreshVersion;
  effect(() => {
    skillsCatalogContextKey();
    const refresh = props.refreshVersion;
    const force = refresh !== lastRefresh;
    lastRefresh = refresh;
    untracked(() => void load(force));
  });
  effect(() => {
    skillsCatalogContextKey();
    void props.ecosystemId;
    detail.set(null);
  });
  cleanup(() => { loadTicket += 1; });

  const belongsToApp = (id: string) => id === "shared" || id === props.ecosystemId;
  const catalog = () => { const value = state(); return value?.kind === "ready" ? value.catalog : null; };
  const rows = computed(() => catalog()?.entries.filter(entry => belongsToApp(entry.ecosystemId)) ?? []);
  const partial = () => catalog()?.failedEcosystems.some(belongsToApp) ?? false;
  const empty = () => {
    if (state()?.kind === "unsupported") return tr("settings.externalImports.instructions.unsupported");
    if (state()?.kind === "error" || partial()) return tr("settings.externalImports.instructions.loadFailed");
    if (state()?.kind !== "ready") return tr("common.loading");
    return tr("settings.externalImports.instructions.empty");
  };
  return (
    <ConfigSection title={tr("settings.externalImports.instructions.title")}
      subtitle={tr("settings.externalImports.instructions.description")} flush
      extra={<If when={state()?.kind === "error" || partial()}>
        <Button label={tr("common.retry")} size="sm" variant="ghost" accessibilityLabel="external-instructions-retry"
          onPress={() => void load(true)} />
      </If>}>
      <If when={rows().length > 0} else={<ConfigRow label={empty()} divider={false} />}>
        <If when={partial()}><InlineBanner tone="warning" message={tr("settings.externalImports.instructions.loadFailed")} /></If>
        <Each of={rows()} key={sourceId}>
          {(source, index) => <ConfigRow label={source().name} description={source().path} wrap topDivider={index() > 0} divider={false}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: space.sm }}>
              <Badge label={scopeLabel(source())} />
              <Button label={tr("common.details")} variant="ghost" size="sm"
                accessibilityLabel={`external-instruction-details-${index()}`} onPress={() => detail.set(source())} />
            </View>
          </ConfigRow>}
        </Each>
      </If>
      <If when={detail()}>{source => <ModalDialog open title={source().name}
        subtitle={`${scopeLabel(source())} · ${applicationLabel(source())}`}
        accessibilityLabel="external-instruction-details" onClose={() => detail.set(null)}
        footer={<Button label={tr("common.close")} variant="secondary" onPress={() => detail.set(null)} />}>
        <View style={{ gap: space.md }}>
          <ConfigSection title={tr("settings.externalImports.sourceLocations")}>
            <Text style={{ ...textStyle("mono"), userSelect: "text" }}>{source().path}</Text>
          </ConfigSection>
          <If when={source().pathPatterns.length > 0}>
            <ConfigSection title={tr("settings.externalImports.instructions.patterns")}>
              <Each of={source().pathPatterns}>{pattern => <Text style={{ ...textStyle("mono"), userSelect: "text" }}>{pattern()}</Text>}</Each>
            </ConfigSection>
          </If>
        </View>
      </ModalDialog>}</If>
    </ConfigSection>
  );
}
