import { cleanup, computed, signal, Text, View } from "nsh";
import type { ModeSkillRow } from "../agentsCatalogStore";
import { formatCount } from "../format";
import { tr, type MessageKey } from "../i18n";
import { readUserSkillGroups, resolveSkillGroups, type UserSkillGroup } from "../skillGroups";
import { skillsCatalogContextKey } from "../skillsCatalogStore";
import { palette, space, textStyle } from "../theme";
import { ChoiceCheckbox } from "../ui/ChoiceIndicator";
import { Badge, Button, InlineBanner } from "../ui/primitives";

const sections = [
  ["user", "agents.skillGroupPicker.myGroups"],
  ["builtin", "agents.skillGroupPicker.builtin"],
  ["other", "agents.skillGroupPicker.otherSkills"],
] as const satisfies ReadonlyArray<readonly [string, MessageKey]>;

export function AgentSkillGroups(props: {
  skills: readonly ModeSkillRow[];
  changes?: ReadonlyMap<string, boolean>;
  disabled: boolean;
  onChange: (keys: readonly string[], enabled: boolean) => void;
}) {
  const personal = signal<UserSkillGroup[]>([]);
  const loadFailed = signal(false);
  const context = skillsCatalogContextKey();
  let mounted = true;
  cleanup(() => { mounted = false; });
  const current = () => mounted && context === skillsCatalogContextKey();
  const load = async () => {
    loadFailed.set(false);
    try {
      const groups = await readUserSkillGroups();
      if (current()) personal.set(groups);
    } catch {
      if (current()) loadFailed.set(true);
    }
  };
  void load();

  const groups = computed(() => resolveSkillGroups(props.skills, personal()));
  const firstGroup = computed(() => {
    const first = new Map<string, string>();
    for (const group of groups()) {
      for (const skill of group.skills) if (!first.has(skill.key)) first.set(skill.key, group.id);
    }
    return first;
  });
  const editing = () => props.changes !== undefined;
  const selected = (skill: ModeSkillRow) => props.changes?.get(skill.key) ?? skill.effectiveEnabled;
  const visibleGroups = computed(() => editing() ? groups() : groups().flatMap(group => {
    const skills = group.skills.filter(skill => skill.effectiveEnabled && firstGroup().get(skill.key) === group.id);
    return skills.length ? [{ ...group, skills }] : [];
  }));
  const duplicateNames = computed(() => {
    const seen = new Set<string>();
    const duplicate = new Set<string>();
    for (const skill of props.skills) {
      if (seen.has(skill.name)) duplicate.add(skill.name);
      seen.add(skill.name);
    }
    return duplicate;
  });
  const label = (skill: ModeSkillRow) => duplicateNames().has(skill.name)
    ? `${skill.name} [${skill.sourceLabel || skill.key}]`
    : skill.name;

  return (
    <View style={{ gap: space.lg }}>
      <If when={loadFailed()}>
        <View style={{ gap: space.sm, padding: space.md, alignItems: "flex-start" }}>
          <InlineBanner tone="warning" message={tr("agents.skillGroupPicker.loadFailed")} />
          <Button label={tr("common.retry")} size="sm" variant="secondary" onPress={() => void load()} />
        </View>
      </If>
      <If when={!editing() && visibleGroups().length === 0}>
        <Text style={{ ...textStyle("caption"), padding: space.lg }}>{tr("common.none")}</Text>
      </If>
      <Each of={sections} key={section => section[0]}>
        {section => {
          const entries = computed(() => visibleGroups().filter(group => group.kind === section()[0]));
          return (
            <If when={entries().length > 0}>
              <View style={{ gap: space.sm }}>
                <Text role="header" style={{ ...textStyle("caption"), paddingHorizontal: space.lg }}>
                  {tr(section()[1])}
                </Text>
                <Each of={entries()} key={group => group.id}>
                  {group => {
                    const selectable = computed(() => group().skills.filter(skill => skill.globallyEnabled));
                    const count = () => selectable().filter(selected).length;
                    const checked = () => selectable().length > 0 && count() === selectable().length;
                    return (
                      <View>
                        <If when={editing() && group().kind !== "other"}>
                          <ChoiceCheckbox checked={checked()} indeterminate={count() > 0 && !checked()}
                            disabled={props.disabled || selectable().length === 0}
                            testID={`agent-skill-group-${group().id}`}
                            accessibilityLabel={tr(checked() ? "agents.skillGroupPicker.clearGroupSkills"
                              : "agents.skillGroupPicker.enableGroupSkills", { name: group().label })}
                            style={{ paddingHorizontal: space.lg, paddingVertical: space.sm }}
                            onChange={enabled => props.onChange(selectable().map(skill => skill.key), enabled)}>
                            <Text style={{ ...textStyle("label"), flex: 1 }}>{group().label}</Text>
                            <Text style={textStyle("caption", { tabular: true })}>
                              {formatCount(count())}/{formatCount(selectable().length)}
                            </Text>
                            <If when={group().unavailableKeys.length > 0}>
                              <Text style={textStyle("caption")}>
                                {tr("agents.skillGroupPicker.unavailableCount", { count: formatCount(group().unavailableKeys.length) })}
                              </Text>
                            </If>
                          </ChoiceCheckbox>
                        </If>
                        <If when={editing()} else={
                          <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm, gap: space.xs }}>
                            <If when={group().kind !== "other"}>
                              <Text style={textStyle("label")}>{group().label}</Text>
                            </If>
                            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
                              <Each of={group().skills} key={skill => skill.key}>
                                {skill => <Badge tone="neutral" label={label(skill())} />}
                              </Each>
                            </View>
                          </View>
                        }>
                          <Each of={group().skills} key={skill => skill.key}>
                            {skill => (
                              <ChoiceCheckbox checked={selected(skill())} disabled={props.disabled || !skill().globallyEnabled}
                                testID={firstGroup().get(skill().key) === group().id
                                  ? `mode-skill-${skill().key}` : `mode-skill-${group().id}-${skill().key}`}
                                accessibilityLabel={label(skill())}
                                style={{ marginHorizontal: space.lg, paddingVertical: space.sm, borderBottomWidth: 1,
                                  borderColor: palette().borderSubtle }}
                                onChange={enabled => props.onChange([skill().key], enabled)}>
                                <View style={{ flex: 1, minWidth: 0, gap: space.xs }}>
                                  <Text style={textStyle("label")}>{label(skill())}</Text>
                                  <Text style={textStyle("caption")}>
                                    {skill().globallyEnabled ? skill().description : tr("agents.modeSkillGloballyOff")}
                                  </Text>
                                </View>
                              </ChoiceCheckbox>
                            )}
                          </Each>
                        </If>
                      </View>
                    );
                  }}
                </Each>
              </View>
            </If>
          );
        }}
      </Each>
    </View>
  );
}
