import { fleetDeviceContext, invokeCommand } from "./bridge";
import { tr, type MessageKey } from "./i18n";

export interface UserSkillGroup {
  id: string;
  name: string;
  skillKeys: string[];
}

interface SkillGroupMember {
  key: string;
  name: string;
  isBuiltin: boolean;
  groupKey: string;
}

export interface SkillGroup<T> {
  id: string;
  kind: "user" | "builtin" | "other";
  label: string;
  skills: T[];
  unavailableKeys: string[];
}

const labels: ReadonlyArray<[string, MessageKey]> = [
  ["meta", "agents.skillGroups.meta"],
  ["miniapp", "agents.skillGroups.miniapp"],
  ["computer-use", "agents.modeComputerUse"],
  ["office", "agents.skillGroups.office"],
  ["canvas", "agents.skillGroups.canvas"],
  ["debugging", "agents.skillGroups.debugging"],
  ["coordination", "agents.skillGroups.coordination"],
  ["planning", "agents.skillGroups.planning"],
  ["creation", "agents.skillGroups.creation"],
];
const builtinGroups = new Map(labels.map(([key, title], order) => [key, { title, order }]));
const configPath = "app.user_skill_groups";

function groupError(key: "invalidConfig" | "unsupportedVersion" | "nameRequired" | "nameDuplicate" | "conflict"): Error {
  return new Error(tr(`skills.groups.errors.${key}`));
}

export async function readUserSkillGroups(target = fleetDeviceContext()): Promise<UserSkillGroup[]> {
  let raw: unknown;
  try {
    raw = await invokeCommand("get_config", { path: configPath, skipRetryOnNotFound: true }, { target });
  } catch (error) {
    if (String(error).includes(`Config path '${configPath}' not found`)) return [];
    throw error;
  }
  if (raw == null) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) throw groupError("invalidConfig");
  const { version = 1, groups } = raw as { version?: unknown; groups?: unknown };
  if (version !== 1) throw groupError("unsupportedVersion");
  if (!Array.isArray(groups)) throw groupError("invalidConfig");
  const seen = new Set<string>();
  return groups.map(group => {
    const id = typeof group?.id === "string" ? group.id.trim() : "";
    const name = typeof group?.name === "string" ? group.name.trim() : "";
    const keys = group?.skillKeys;
    if (!id || !name || seen.has(id) || !Array.isArray(keys) ||
      keys.some(key => typeof key !== "string" || !key.trim())) {
      throw groupError("invalidConfig");
    }
    seen.add(id);
    return { id, name, skillKeys: [...new Set(keys.map(key => key.trim()))] };
  });
}

export async function updateUserSkillGroups(
  target: string | null,
  current: () => boolean,
  change: (groups: UserSkillGroup[]) => UserSkillGroup[],
): Promise<UserSkillGroup[] | undefined> {
  if (!current()) return;
  const groups = await readUserSkillGroups(target);
  if (!current()) return;
  const next = change(groups);
  if (next !== groups) {
    await invokeCommand("set_config", { path: configPath, value: { version: 1, groups: next } }, { target });
  }
  return current() ? next : undefined;
}

function matchesGroup(current: UserSkillGroup | undefined, original: UserSkillGroup): boolean {
  return current?.id === original.id && current.name === original.name &&
    current.skillKeys.length === original.skillKeys.length &&
    current.skillKeys.every((key, index) => key === original.skillKeys[index]);
}

export function saveUserSkillGroup(groups: UserSkillGroup[], group: UserSkillGroup, original: UserSkillGroup | null): UserSkillGroup[] {
  const name = group.name.trim();
  if (!name) throw groupError("nameRequired");
  const current = groups.find(item => item.id === group.id);
  if (original ? !matchesGroup(current, original) : current) throw groupError("conflict");
  if (groups.some(item => item.id !== group.id && item.name.toLowerCase() === name.toLowerCase())) {
    throw groupError("nameDuplicate");
  }
  const next = { ...group, name };
  return original ? groups.map(item => item.id === group.id ? next : item) : [...groups, next];
}

export function deleteUserSkillGroup(groups: UserSkillGroup[], original: UserSkillGroup): UserSkillGroup[] {
  if (!matchesGroup(groups.find(item => item.id === original.id), original)) throw groupError("conflict");
  return groups.filter(item => item.id !== original.id);
}

export function moveUserSkillGroup(groups: UserSkillGroup[], id: string, direction: -1 | 1): UserSkillGroup[] {
  const index = groups.findIndex(group => group.id === id);
  if (index < 0) throw groupError("conflict");
  const neighbor = index + direction;
  if (neighbor < 0 || neighbor >= groups.length) return groups;
  const next = [...groups];
  [next[index], next[neighbor]] = [next[neighbor], next[index]];
  return next;
}

export function resolveSkillGroups<T extends SkillGroupMember>(
  skills: readonly T[], personal: readonly UserSkillGroup[],
): SkillGroup<T>[] {
  const available = new Map<string, T>();
  for (const skill of skills) {
    if (!available.has(skill.key)) available.set(skill.key, skill);
  }
  const sorted = (members: T[]) =>
    members.sort((left, right) => left.name.localeCompare(right.name) || left.key.localeCompare(right.key));
  const grouped = new Set<string>();
  const result: SkillGroup<T>[] = personal.map(group => {
    const members: T[] = [];
    const unavailableKeys: string[] = [];
    for (const key of group.skillKeys) {
      const skill = available.get(key);
      if (skill) {
        members.push(skill);
        grouped.add(key);
      } else {
        unavailableKeys.push(key);
      }
    }
    return { id: `user:${group.id}`, kind: "user", label: group.name, skills: sorted(members), unavailableKeys };
  });

  const byGroup = new Map<string, T[]>();
  for (const skill of available.values()) {
    if (!skill.isBuiltin || !skill.groupKey) continue;
    const members = byGroup.get(skill.groupKey) ?? [];
    members.push(skill);
    byGroup.set(skill.groupKey, members);
    grouped.add(skill.key);
  }
  const builtins = [...byGroup].map(([key, members]) => {
    const builtin = builtinGroups.get(key);
    return { key, label: builtin ? tr(builtin.title) : key, order: builtin?.order ?? labels.length, members };
  }).sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  for (const group of builtins) {
    result.push({ id: `builtin:${group.key}`, kind: "builtin", label: group.label, skills: sorted(group.members), unavailableKeys: [] });
  }
  const other = sorted([...available.values()].filter(skill => !grouped.has(skill.key)));
  if (other.length) {
    result.push({ id: "other", kind: "other", label: tr("agents.skillGroupPicker.otherSkills"), skills: other, unavailableKeys: [] });
  }
  return result;
}
