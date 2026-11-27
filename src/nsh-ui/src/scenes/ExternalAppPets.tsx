import { cleanup, effect, Image, signal, Text, untracked, View } from "nsh";
import {
  companionBusy, companionEnabled, externalCompanionAvailableHere, importReviewedCompanionPet,
  loadCompanionSettings, loadExternalCompanionPets, selectCompanionPet, selectedPet, setCompanionEnabled,
  type ExternalCompanionPet, type ExternalCompanionPetCatalog,
} from "../companionStore";
import { isCommandMissing } from "../externalImportStore";
import { tr } from "../i18n";
import { space, textStyle } from "../theme";
import { ModalDialog } from "../ui/overlays";
import { Badge, Button, ConfigRow, ConfigSection, InlineBanner } from "../ui/primitives";

function PetPreview(props: { candidate: ExternalCompanionPet; large?: boolean }) {
  return <Image src={props.candidate.previewDataUrl} accessibilityLabel={props.candidate.pet.displayName}
    style={{ width: props.large ? 112 : 44, height: props.large ? 100 : 40, objectFit: "contain" }} />;
}

function origin(candidate: ExternalCompanionPet): string {
  return tr(candidate.builtinId ? "settings.externalImports.pets.builtin" : "settings.externalImports.pets.custom");
}

export function ExternalAppPets(props: { refreshVersion: number; onManage: () => void }) {
  const catalog = signal<ExternalCompanionPetCatalog | null>(null);
  const review = signal<ExternalCompanionPet | null>(null);
  const busy = signal(false);
  const loading = signal(false);
  const status = signal<"idle" | "ready" | "unsupported" | "failed">("idle");
  const feedback = signal<"imported" | "failed" | null>(null);
  let loadTicket = 0;
  let operationTicket = 0;

  async function load() {
    const ticket = ++loadTicket;
    if (!externalCompanionAvailableHere()) return;
    loading.set(true);
    try {
      const next = await loadExternalCompanionPets();
      if (ticket !== loadTicket || !externalCompanionAvailableHere()) return;
      catalog.set(next);
      status.set(next ? "ready" : "unsupported");
    } catch (error) {
      if (ticket !== loadTicket || !externalCompanionAvailableHere()) return;
      status.set(isCommandMissing("list_agent_companion_pets", error) ? "unsupported" : "failed");
    } finally {
      if (ticket === loadTicket) loading.set(false);
    }
  }

  effect(() => {
    const supported = externalCompanionAvailableHere();
    void props.refreshVersion;
    untracked(() => {
      if (supported) {
        void load();
        void loadCompanionSettings();
      } else {
        loadTicket += 1;
        operationTicket += 1;
        catalog.set(null);
        review.set(null);
        busy.set(false);
        loading.set(false);
        status.set("idle");
        feedback.set(null);
      }
    });
  });
  cleanup(() => { loadTicket += 1; operationTicket += 1; });

  const ready = () => externalCompanionAvailableHere() && status() === "ready" && !loading();
  const canStart = () => ready() && !busy() && !companionBusy();
  const entries = () => externalCompanionAvailableHere() ? catalog()?.candidates ?? [] : [];
  const close = () => { if (!busy()) review.set(null); };
  const isUsing = (item: ExternalCompanionPet) => Boolean(item.imported?.packagePath
    && companionEnabled() === true && selectedPet()?.packagePath === item.imported.packagePath);
  const petStatus = (item: ExternalCompanionPet) => {
    if (item.copyModified) return tr("settings.externalImports.pets.copyModified");
    if (item.sourceChanged) return tr("settings.externalImports.pets.sourceChanged");
    if (isUsing(item)) return tr("settings.externalImports.pets.using");
    return item.imported ? tr("settings.externalImports.state.imported") : "";
  };
  const emptyLabel = () => {
    if (!externalCompanionAvailableHere()) return tr("settings.externalImports.pets.localOnly");
    if (loading()) return tr("common.loading");
    if (status() === "unsupported") return tr("settings.externalImports.pets.unsupported");
    if (status() === "failed") return tr("settings.externalImports.pets.loadFailed");
    return tr("settings.externalImports.pets.empty");
  };

  async function run(action: (current: () => boolean) => Promise<void>) {
    if (!canStart()) return;
    const ticket = ++operationTicket;
    const current = () => operationTicket === ticket && externalCompanionAvailableHere();
    busy.set(true);
    feedback.set(null);
    try {
      await action(current);
    } catch {
      if (!current()) return;
      review.set(null);
      feedback.set("failed");
      await load();
    } finally {
      if (current()) busy.set(false);
    }
  }

  async function apply(candidate: ExternalCompanionPet) {
    await run(async current => {
      await importReviewedCompanionPet(candidate);
      if (!current()) return;
      review.set(null);
      feedback.set("imported");
      await load();
    });
  }

  async function activate(candidate: ExternalCompanionPet) {
    await run(async current => {
      const next = await loadExternalCompanionPets();
      if (!current()) return;
      const pet = next?.candidates.find(item => item.sourceKey === candidate.sourceKey)?.imported;
      if (!pet || pet.id !== candidate.imported?.id || pet.packagePath !== candidate.imported.packagePath) throw new Error("stale_pet_copy");
      if (!await selectCompanionPet(pet)) throw new Error("pet_selection_failed");
      if (!current()) return;
      if (companionEnabled() !== true && !await setCompanionEnabled(true)) throw new Error("pet_enable_failed");
      if (current()) catalog.set(next);
    });
  }

  return (
    <ConfigSection title={tr("settings.externalImports.pets.title")} subtitle={tr("settings.externalImports.pets.description")} flush
      extra={<If when={externalCompanionAvailableHere()}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: space.sm }}>
          <Button label={tr("common.refresh")} variant="ghost" size="sm" leadingIcon="refresh"
            accessibilityLabel="external-pets-refresh" disabled={busy() || loading()}
            onPress={() => { feedback.set(null); void load(); }} />
          <Button label={tr("settings.externalImports.pets.manage")} variant="secondary" size="sm"
            accessibilityLabel="external-pets-manage" disabled={busy()} onPress={props.onManage} />
        </View>
      </If>}>
      <If when={feedback()}>{value => <InlineBanner tone={value() === "imported" ? "success" : "warning"}
        message={tr(value() === "imported" ? "settings.externalImports.pets.imported" : "settings.externalImports.pets.failed")}
        onDismiss={() => feedback.set(null)} />}
      </If>
      <If when={status() === "failed" && entries().length > 0}>
        <InlineBanner tone="warning" message={tr("settings.externalImports.pets.loadFailed")} />
      </If>
      <Each of={externalCompanionAvailableHere() ? catalog()?.diagnostics ?? [] : []}>
        {diagnostic => <InlineBanner tone="neutral" message={diagnostic()} />}
      </Each>
      <If when={entries().length > 0} else={<ConfigRow label={emptyLabel()} divider={false} />}>
        <Each of={entries()} key={candidate => candidate.sourceKey}>
          {(candidate, index) => (
            <ConfigRow label={candidate().pet.displayName}
              description={`${origin(candidate())} · ${candidate().pet.packagePath}`}
              wrap topDivider={index() > 0} divider={false}>
              <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: space.sm }}>
                <PetPreview candidate={candidate()} />
                <If when={petStatus(candidate())}>
                  {label => <Badge label={label()} tone={candidate().copyModified || candidate().sourceChanged ? "warning"
                    : isUsing(candidate()) ? "success" : "neutral"} />}
                </If>
                <If when={candidate().imported} else={<Button label={tr("settings.externalImports.pets.review")} size="sm" variant="secondary"
                  accessibilityLabel={`external-pet-review-${candidate().sourceKey}`} disabled={!canStart()}
                  onPress={() => { feedback.set(null); review.set(candidate()); }} />}>
                  <Button label={tr("settings.externalImports.pets.use")} size="sm" variant="secondary"
                    accessibilityLabel={`external-pet-use-${candidate().sourceKey}`} disabled={!canStart() || isUsing(candidate())}
                    onPress={() => void activate(candidate())} />
                </If>
              </View>
            </ConfigRow>
          )}
        </Each>
      </If>
      <If when={review()}>{candidate => <ModalDialog open title={tr("settings.externalImports.pets.reviewTitle")}
        subtitle={candidate().pet.displayName} accessibilityLabel="external-pet-review-dialog" onClose={close}
        closeOnEscape={!busy()} closeOnBackdropPress={!busy()}
        footer={<>
          <Button label={tr("common.cancel")} variant="secondary" disabled={busy()} onPress={close} />
          <Button label={tr("settings.externalImports.import")} variant="primary" accessibilityLabel="external-pet-confirm"
            disabled={!canStart()} loading={busy()} onPress={() => void apply(candidate())} />
        </>}>
        <View style={{ gap: space.sm }}>
          <PetPreview candidate={candidate()} large />
          <Text style={textStyle("body")}>{tr("settings.externalImports.pets.reviewDescription")}</Text>
          <Text style={{ ...textStyle("caption"), userSelect: "text" }}>{`${origin(candidate())} · ${candidate().pet.packagePath}`}</Text>
        </View>
      </ModalDialog>}</If>
    </ConfigSection>
  );
}
