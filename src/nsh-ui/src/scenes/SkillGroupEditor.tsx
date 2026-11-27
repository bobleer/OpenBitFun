import { computed, signal, Text, View } from "nsh";
import { formatPlural } from "../format";
import { localizeHostError, tr } from "../i18n";
import { isSkillDisabled, type SkillRecord } from "../skillsCatalogStore";
import type { UserSkillGroup } from "../skillGroups";
import { palette, space, textStyle } from "../theme";
import { ChoiceCheckbox } from "../ui/ChoiceIndicator";
import { ModalDialog } from "../ui/overlays";
import { Button, InlineBanner, InlineConfirmBar, SearchInput, TextField } from "../ui/primitives";

export interface SkillGroupDraft {
  group: UserSkillGroup;
  original: UserSkillGroup | null;
  readOnly?: boolean;
}

export function SkillGroupEditor(props: {
  draft: SkillGroupDraft;
  skills: readonly SkillRecord[];
  catalogComplete: boolean;
  saving: boolean;
  onClose: () => void;
  onCopy: () => void;
  onSave: (group: UserSkillGroup) => Promise<boolean>;
}) {
  const initial = props.draft.group;
  const name = signal(initial.name);
  const keys = signal(initial.skillKeys);
  const selected = computed(() => new Set(keys()));
  const query = signal("");
  const selectedOnly = signal(Boolean(props.draft.readOnly));
  const error = signal("");
  const confirmDiscard = signal(false);
  const dirty = () => name() !== initial.name || selected().size !== initial.skillKeys.length ||
    initial.skillKeys.some(key => !selected().has(key));
  const candidates = computed(() => {
    const catalog = new Map(props.skills.map(skill => [skill.key, skill]));
    return [...new Set([...catalog.keys(), ...initial.skillKeys])].map(key => ({ key, skill: catalog.get(key) }))
      .sort((a, b) => (a.skill?.name ?? a.key).localeCompare(b.skill?.name ?? b.key) || a.key.localeCompare(b.key));
  });
  const visible = computed(() => {
    const search = query().trim().toLowerCase();
    return candidates().filter(({ key, skill }) =>
      (!selectedOnly() || selected().has(key)) &&
      (!search || [key, skill?.name, skill?.description, skill?.sourceLabel].some(value => value?.toLowerCase().includes(search))));
  });
  const close = () => {
    if (props.saving) return;
    if (dirty() && !props.draft.readOnly) confirmDiscard.set(true);
    else props.onClose();
  };
  const save = async () => {
    if (props.saving || props.draft.readOnly || confirmDiscard()) return;
    error.set("");
    if (!name().trim()) {
      error.set(tr("skills.groups.errors.nameRequired"));
      return;
    }
    try {
      if (await props.onSave({ ...initial, name: name(), skillKeys: keys() })) props.onClose();
    } catch (err) {
      error.set(localizeHostError(err) || tr("skills.groups.errors.saveFailed"));
    }
  };

  return (
    <ModalDialog open title={props.draft.readOnly ? initial.name : tr(props.draft.original ? "skills.groups.edit" : "skills.groups.create")}
      size="lg" accessibilityLabel="skill-group-editor" onClose={close}
      footer={
        <If when={confirmDiscard()} else={
          <>
            <Button label={tr("common.close")} variant="secondary" disabled={props.saving}
              accessibilityLabel="skill-group-editor-close" onPress={close} />
            <If when={props.draft.readOnly} else={
              <Button label={tr("skills.groups.save")} variant="primary" loading={props.saving} disabled={props.saving}
                accessibilityLabel="skill-group-editor-save" onPress={() => void save()} />
            }>
              <Button label={tr("skills.groups.copy")} variant="primary" accessibilityLabel="skill-group-editor-copy" onPress={props.onCopy} />
            </If>
          </>
        }>
          <InlineConfirmBar message={tr("skills.groups.discardMessage")} danger
            confirmLabel={tr("skills.groups.discard")} cancelLabel={tr("skills.groups.keepEditing")}
            onConfirm={props.onClose} onCancel={() => confirmDiscard.set(false)} />
        </If>
      }>
      <View style={{ gap: space.md }}>
        <If when={!props.draft.readOnly}>
          <TextField value={name()} label={tr("skills.groups.name")} placeholder={tr("skills.groups.namePlaceholder")}
            accessibilityLabel="skill-group-editor-name" disabled={props.saving} autoFocus
            onChange={value => { name.set(value); error.set(""); }} onSubmit={() => void save()} />
        </If>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
          <SearchInput value={query()} placeholder={tr("skills.groups.searchSkills")} style={{ flexGrow: 1, minWidth: 160 }}
            accessibilityLabel="skill-group-editor-search" onChange={value => query.set(value)} />
          <If when={!props.draft.readOnly}>
            <ChoiceCheckbox checked={selectedOnly()} accessibilityLabel={tr("skills.groups.selectedOnly")}
              testID="skill-group-editor-selected" style={{ width: "auto", alignItems: "center" }}
              onChange={checked => selectedOnly.set(checked)}>
              <Text style={textStyle("label")}>{tr("skills.groups.selectedOnly")}</Text>
            </ChoiceCheckbox>
          </If>
        </View>
        <Text style={textStyle("caption")}>
          {formatPlural(selected().size, "skills.groups.memberCountOne", "skills.groups.memberCount")}
        </Text>
        <If when={!props.catalogComplete}>
          <InlineBanner tone="neutral" message={tr("skills.groups.catalogUnavailable")} />
        </If>
        <If when={error()}>{message => <InlineBanner tone="warning" message={message()} />}</If>
        <If when={visible().length === 0}>
          <Text style={textStyle("caption")}>{tr("skills.groups.noMatchingSkills")}</Text>
        </If>
        <Each of={visible()} key={item => item.key}>
          {item => {
            const title = () => item().skill?.name ?? item().key;
            const detail = () => {
              const { skill, key } = item();
              if (!skill) return tr(props.catalogComplete ? "skills.groups.unavailableMember" : "skills.groups.unresolvedMember");
              return [skill.sourceLabel, skill.description, isSkillDisabled(key) ? tr("skills.groups.globalDisabled") : ""]
                .filter(Boolean).join(" · ");
            };
            const content = () => (
              <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
                <Text style={{ ...textStyle("label"), numberOfLines: 1, textOverflow: "ellipsis" }}>{title()}</Text>
                <Text style={{ ...textStyle("caption"), numberOfLines: 2, textOverflow: "ellipsis" }}>{detail()}</Text>
              </View>
            );
            const rowStyle = () => ({
              paddingVertical: space.sm, paddingHorizontal: space.xs,
              borderBottomWidth: 1, borderColor: palette().borderSubtle,
            });
            return (
              <If when={props.draft.readOnly} else={
                <ChoiceCheckbox checked={selected().has(item().key)} disabled={props.saving}
                  accessibilityLabel={`${title()}. ${detail()}`} testID={`skill-group-editor-member-${item().key}`}
                  style={rowStyle()} onChange={checked => {
                    const key = item().key;
                    keys.update(current => checked ? [...new Set([...current, key])] : current.filter(member => member !== key));
                    error.set("");
                  }}>
                  {content()}
                </ChoiceCheckbox>
              }>
                <View style={rowStyle()}>{content()}</View>
              </If>
            );
          }}
        </Each>
      </View>
    </ModalDialog>
  );
}
