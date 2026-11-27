import { Image, signal, Text, View, type ViewRef } from "nsh";
import { Radio, RadioGroup } from "nsh/base";
import { formatCount } from "../format";
import { localizeHostError, tr, type MessageKey } from "../i18n";
import { modelOptionDetail, modelOptionLabel, modelSettingsLoaded, selectableChatModels, storedModels } from "../modelSettingsStore";
import {
  movePoolMember, POOL_STRATEGIES, poolBusy, poolDraft, poolStatusLoading, poolStatuses, poolsNotice,
  retryPoolMember, togglePoolMember, updatePoolDraft,
} from "../poolStore";
import { poolStrategyArtwork } from "../poolStrategyArtwork";
import { palette, radii, space, textStyle } from "../theme";
import { ChoiceIndicator } from "../ui/ChoiceIndicator";
import { DropdownMenu, ModalDialog } from "../ui/overlays";
import { Badge, Button, ConfigRow, focusRingStyle, IconButton, InlineBanner, InputBox, SearchInput, type BadgeTone } from "../ui/primitives";

const strategyPresentation = {
  ordered: { label: "settings.pools.strategyOrdered", hint: "settings.pools.strategyOrderedHint" },
  balanced: { label: "settings.pools.strategyBalanced", hint: "settings.pools.strategyBalancedHint" },
} as const;

export function poolStrategyLabel(strategy: string): string {
  if (strategy === "ordered" || strategy === "balanced") return tr(strategyPresentation[strategy].label);
  return tr("settings.pools.unsupportedStrategy");
}

function PoolStrategyCards() {
  const selected = () => poolDraft()?.strategy;
  return <RadioGroup accessibilityLabel={tr("settings.pools.routingStrategy")}
    style={{ flexDirection: "row", gap: space.sm, width: "100%" }}>
    <Each of={POOL_STRATEGIES} key={strategy => strategy}>{entry => {
      const strategy = entry();
      const active = () => selected() === strategy;
      const hint = () => tr(strategyPresentation[strategy].hint);
      return <Radio testID={`pool-strategy-${strategy}`} accessibilityLabel={poolStrategyLabel(strategy)}
        checked={active()} disabled={poolBusy()} focusVisibleStyle={focusRingStyle()}
        onChange={() => updatePoolDraft({ strategy })}
        style={{ flex: 1, minWidth: 0, overflow: "hidden", borderWidth: 1, borderRadius: radii.md,
          borderCurve: "continuous", borderColor: active() ? palette().borderFocus : palette().borderSubtle,
          backgroundColor: active() ? palette().accentSoft : palette().panelRaised, cursor: "pointer" }}>
        <If when={poolStrategyArtwork()}>{artwork => (
          <View accessibilityElementsHidden style={{ width: "100%", aspectRatio: 1.5, overflow: "hidden" }}>
            <Image src={artwork()} fadeDuration={0} style={{ position: "absolute", top: 0,
              left: strategy === "ordered" ? 0 : "-100%", width: "200%", height: "100%", objectFit: "fill" }} />
          </View>
        )}</If>
        <View style={poolStrategyArtwork() ? { position: "absolute", top: space.xs, right: space.xs }
          : { alignSelf: "flex-end", marginTop: space.xs, marginRight: space.xs }}>
          <ChoiceIndicator kind="radio" checked={active()} disabled={poolBusy()} />
        </View>
        <View style={{ gap: space.hair, padding: space.sm }}>
          <Text style={{ ...textStyle("label"), textAlign: "center" }}>{poolStrategyLabel(strategy)}</Text>
          <Text style={{ ...textStyle("caption"), textAlign: "center" }}>{hint()}</Text>
        </View>
      </Radio>;
    }}</Each>
  </RadioGroup>;
}

function PoolMemberPicker() {
  const open = signal(false);
  const search = signal("");
  const options = () => selectableChatModels();
  const visible = () => {
    const needle = search().trim().toLowerCase();
    return options().filter(model => `${modelOptionLabel(model)} ${modelOptionDetail(model)} ${model.id}`.toLowerCase().includes(needle));
  };
  const close = () => {
    open.set(false);
    search.set("");
  };
  return <>
    <Button label={tr("settings.pools.addMembers")} leadingIcon="plus" size="sm" variant="primary"
      accessibilityLabel="pool-add-members" disabled={poolBusy()} onPress={() => open.set(true)} />
    <ModalDialog open={open()} title={tr("settings.pools.addMembers")} size="sm" accessibilityLabel="pool-member-picker"
      onClose={close} footer={<Button label={tr("common.done")} size="md" accessibilityLabel="pool-member-picker-done" onPress={close} />}>
      <View style={{ gap: space.md }}>
        <SearchInput value={search()} onChange={search.set} onClear={() => search.set("")} autoFocus
          placeholder={tr("settings.pools.searchModels")} accessibilityLabel="pool-member-search" />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          <Each of={visible()} key={model => model.id}>{model => {
            const selected = () => poolDraft()?.members.includes(model().id) === true;
            return <Button label={modelOptionLabel(model())} variant={selected() ? "secondary" : "outline"} size="sm"
              leadingIcon={selected() ? "check" : "plus"} tooltip={modelOptionDetail(model())}
              accessibilityLabel={`pool-toggle-${model().id}`} disabled={poolBusy()}
              onPress={() => togglePoolMember(model().id)} />;
          }}</Each>
          <If when={visible().length === 0}>
            <Text style={textStyle("caption")}>{tr(!modelSettingsLoaded() ? "common.loading"
              : options().length ? "settings.pools.noModelMatches" : "settings.pools.noModels")}</Text>
          </If>
        </View>
      </View>
    </ModalDialog>
  </>;
}

const health = new Map<string, { label: MessageKey; tone?: BadgeTone }>([
  ["unverified", { label: "settings.pools.healthUnverified" }],
  ["available", { label: "settings.pools.healthAvailable", tone: "success" }],
  ["cooling_down", { label: "settings.pools.healthCoolingDown", tone: "warning" }],
  ["probing", { label: "settings.pools.healthProbing", tone: "accent" }],
  ["needs_attention", { label: "settings.pools.healthNeedsAttention", tone: "danger" }],
  ["disabled", { label: "common.disabled" }],
  ["missing", { label: "settings.pools.healthMissing", tone: "warning" }],
]);

function PoolMember(props: { id: string; index: number; count: number }) {
  const open = signal(false);
  const anchor = signal<ViewRef | null>(null);
  const model = () => storedModels().find(item => item.id === props.id);
  const poolId = () => poolDraft()?.id ?? "";
  const status = () => (poolStatuses()[poolId()] ?? []).find(entry => entry.modelId === props.id);
  const badge = () => health.get(status()?.status ?? (model() ? "unverified" : "missing"));
  const name = () => model() ? modelOptionLabel(model()!) : props.id;
  const retry = () => ["cooling_down", "needs_attention"].includes(status()?.status ?? "");
  return <View role="row" style={{ gap: space.xs, padding: space.sm, borderRadius: radii.md,
    borderWidth: 1, borderColor: palette().borderSubtle, backgroundColor: palette().surfaceTertiary }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs }}>
      <Badge label={formatCount(props.index + 1)} size="xs" />
      <View ref={anchor.set} style={{ minWidth: 0 }}>
        <Button label={name()} size="sm" pill variant="secondary" trailingIcon="chevron-down"
          accessibilityLabel={`pool-member-actions-${props.id}`} disabled={poolBusy()} onPress={() => open.set(!open())} />
      </View>
      <Badge label={badge() ? tr(badge()!.label) : status()?.status ?? ""} tone={badge()?.tone} size="xs" />
      <IconButton icon="close" size="xs" tooltip={tr("common.remove")} disabled={poolBusy()}
        accessibilityLabel={`pool-member-remove-${props.id}`} onPress={() => togglePoolMember(props.id)} />
    </View>
    <If when={status()?.reason}>{reason => <Text style={textStyle("caption")}>{localizeHostError(reason())}</Text>}</If>
    <DropdownMenu open={open() && !poolBusy()} anchor={anchor()} onClose={() => open.set(false)} items={[
      ...(retry() ? [{ id: "retry", label: tr("settings.pools.retryMember"), icon: "refresh" as const,
        disabled: poolStatusLoading() !== null, accessibilityLabel: `pool-member-retry-${props.id}`,
        onSelect: () => void retryPoolMember(props.id) }] : []),
      { id: "up", label: tr("common.up"), icon: "arrow-up", disabled: props.index === 0,
        accessibilityLabel: `pool-member-up-${props.id}`, onSelect: () => movePoolMember(props.id, -1) },
      { id: "down", label: tr("common.down"), icon: "chevron-down", disabled: props.index === props.count - 1,
        accessibilityLabel: `pool-member-down-${props.id}`, onSelect: () => movePoolMember(props.id, 1) },
    ]} />
  </View>;
}

export function ModelPoolEditor() {
  const members = () => poolDraft()?.members ?? [];
  const nameLabel = () => tr("settings.pools.poolName");
  return <View style={{ gap: space.md }}>
    <If when={poolsNotice()}>{notice => <InlineBanner tone="danger" message={localizeHostError(notice())} />}</If>
    <ConfigRow label={nameLabel()} stacked divider={false} controlAlign="stretch"
      style={{ paddingHorizontal: 0, paddingVertical: 0 }}>
      <InputBox size="md" value={poolDraft()?.name ?? ""} placeholder={tr("settings.pools.namePlaceholder")}
        accessibilityLabel="model-pool-name" disabled={poolBusy()} onChange={name => updatePoolDraft({ name })} />
    </ConfigRow>
    <View style={{ gap: space.sm }}>
      <Text style={textStyle("label")}>{tr("settings.pools.routingStrategy")}</Text>
      <Text style={textStyle("caption")}>{tr("settings.pools.stickyHint")}</Text>
      <PoolStrategyCards />
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: space.sm }}>
      <Text style={textStyle("label")}>
        {members().length > 0 ? tr("settings.pools.membersInOrder", { count: formatCount(members().length) })
          : tr("settings.pools.membersInOrderEmpty")}
      </Text>
      <PoolMemberPicker />
    </View>
    <View role="list" style={{ gap: space.xs }}>
      <Each of={members()} key={id => id}>{(id, index) => <PoolMember id={id()} index={index()} count={members().length} />}</Each>
    </View>
  </View>;
}
