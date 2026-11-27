// The models a chat can run and the one each session picked. The host keeps the
// catalog and the session binding; this store only mirrors them for the composer.

import { computed, signal } from "nsh";
import {
  getConfig,
  getModelCatalog,
  getSessionModelTarget,
  projectAiModelReasoningCatalog,
  updateSessionModel,
  updateSessionModelTarget,
  type ModelCatalogEntry,
  type ModelCatalog,
  type ReasoningCatalogProjection,
  type ReasoningPresetDescriptor,
  type SessionModelTargetResponse,
} from "./api";
import { entryDeviceId, fleetActive, invokeCommand, listenEvent } from "./bridge";
import { FLEET_INDEX_CHANGED_EVENT } from "./fleetTypes";
import { tr } from "./i18n";
import {
  loadModels as loadStoredModels,
  onDefaultModelsChanged,
  saveModelContextWindow,
  storedModels,
  type StoredModel,
} from "./modelSettingsStore";
import {
  activeSessionDevice,
  activeSessionId,
  activeSessionKey,
  activeWorkspaceId,
  deviceContext,
  deviceOfSession,
  onSessionCreated,
  onWorkspaceChanged,
  runStep,
  sessionKey,
  sessions,
} from "./state";

// ── The account-wide catalog (`fleet_models`) ─────────────────────────────────
// Every device's models, grouped by device, as the entry projects them: the
// device that runs the session first, each device's state, which rows can be
// picked, and the reference to store. Nothing is ordered or gated here.

/** One configured model of a device (`FleetModel`). */
export interface FleetModel {
  modelId: string;
  displayName: string;
  provider: string;
  modelName?: string;
  capabilities?: string[];
  contextWindow?: number;
  primary?: boolean;
  /** What every list shows first: the model (the host's label rule). */
  label?: string;
  /** The secondary text beside `label`: the provider, numbered when two read the same. */
  detail?: string;
}

/**
 * A device model's label and secondary text as the host projected them. A host
 * from before the label rule sends neither: its name and provider are read as
 * they were shown then.
 */
export function fleetModelText(model: FleetModel): { label: string; detail: string } {
  if (model.label) return { label: model.label, detail: model.detail ?? "" };
  return { label: model.displayName || model.modelId, detail: model.provider ?? "" };
}

/** One row of the picker (`FleetModelChoice`). */
export interface FleetModelChoice extends FleetModel {
  /** What `update_session_model` stores (plain for this device, `fleet:<device>/<model>` otherwise). */
  modelRef: string;
  selectable: boolean;
}

/** One device's group (`FleetModelsDevice`). */
export interface FleetModelsDevice {
  deviceId: string;
  name: string;
  hostKind?: string;
  state?: string;
  online: boolean;
  isThisDevice: boolean;
  /** `device_offline`, `device_requires_update`, `no_model`; absent when its models can be picked. */
  unavailableReason?: string;
  models: FleetModelChoice[];
}

/** The groups the entry answered for the open session, or `null` (no fleet, older host): the local list. */
export const fleetModelGroups = signal<FleetModelsDevice[] | null>(null);

/** The device that runs the open session, when it is not the entry itself (`fleet_models {deviceId}`). */
function catalogDeviceId(): string | undefined {
  const owner = deviceOfSession(activeSessionId());
  return owner && owner !== entryDeviceId() ? owner : undefined;
}

let fleetModelsTicket = 0;
let fleetModelsFollowing = false;

export async function readFleetModelsForDevice(deviceId?: string): Promise<FleetModelsDevice[] | null> {
  if (!fleetActive()) return null;
  const owner = deviceId && deviceId !== entryDeviceId() ? deviceId : undefined;
  const answer = await invokeCommand<{ devices?: FleetModelsDevice[] }>("fleet_models", owner ? { deviceId: owner } : {});
  return Array.isArray(answer?.devices) && answer.devices.length ? answer.devices : null;
}

/**
 * Reads `fleet_models` for the open session. A host that does not answer it
 * (signed out, no fleet, an older build) keeps the local-only list.
 */
export async function refreshFleetModels(): Promise<void> {
  const ticket = ++fleetModelsTicket;
  if (!fleetActive()) {
    fleetModelGroups.set(null);
    return;
  }
  if (!fleetModelsFollowing) {
    fleetModelsFollowing = true;
    listenEvent(FLEET_INDEX_CHANGED_EVENT, () => {
      if (fleetModelGroups() !== null) void refreshFleetModels();
    });
  }
  const deviceId = catalogDeviceId();
  try {
    const answer = await readFleetModelsForDevice(deviceId);
    if (ticket !== fleetModelsTicket) return;
    fleetModelGroups.set(answer);
  } catch {
    if (ticket === fleetModelsTicket) fleetModelGroups.set(null);
  }
}

/** The catalog row and its device for a stored reference, when the catalog lists it. */
export function fleetChoiceOf(ref: string | null | undefined): { device: FleetModelsDevice; choice: FleetModelChoice } | null {
  if (!ref) return null;
  for (const device of fleetModelGroups() ?? []) {
    const choice = device.models.find(model => model.modelRef === ref);
    if (choice) return { device, choice };
  }
  return null;
}

export interface ModelOption {
  /** Wire value sent to `update_session_model` (config ID on real Rust hosts). */
  id: string;
  /** Stable config entry ID from `RemoteModelConfig.id`. */
  configId: string;
  configName: string;
  /** Upstream model identifier (`RemoteModelConfig.model_name`). */
  modelName: string;
  /** What the picker shows first (the host's `label`). */
  label: string;
  /** The secondary text beside `label` (the host's `detail`). */
  detail: string;
  provider: string;
  /** Models that cannot chat (image or speech models) are not offered. */
  chat: boolean;
  /** The context window the catalog declares, for the composer's usage ring. */
  contextWindow?: number;
}

/** Default session context length (300K tokens). */
export const DEFAULT_SESSION_CONTEXT_TOKENS = 300_000;
export const MIN_SESSION_CONTEXT_TOKENS = 4_096;
export const MAX_SESSION_CONTEXT_TOKENS = 10_000_000;

export interface ContextLengthPreset {
  tokens: number;
  label: string;
  isDefault?: boolean;
}

export const CONTEXT_LENGTH_PRESETS: readonly ContextLengthPreset[] = [
  { tokens: 128_000, label: "128K" },
  { tokens: 256_000, label: "256K" },
  { tokens: 300_000, label: "300K", isDefault: true },
  { tokens: 500_000, label: "500K" },
  { tokens: 1_000_000, label: "1M" },
];

/** Parses a custom context length string (`"400K"`, `"1.5M"`, `"400000"`, `"256,000"`). */
export function parseContextLengthInput(raw: string): number | null {
  const cleaned = raw.trim().replace(/[,\s_]/g, "").toUpperCase();
  if (!cleaned) return null;
  const match = /^(\d+(?:\.\d+)?)([KM])?$/.exec(cleaned);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2];
  const multiplier = unit === "M" ? 1_000_000 : unit === "K" ? 1_000 : 1;
  const tokens = Math.round(value * multiplier);
  if (tokens < MIN_SESSION_CONTEXT_TOKENS || tokens > MAX_SESSION_CONTEXT_TOKENS) return null;
  return tokens;
}

/** Short human label for a context length in tokens (`128K`, `300K`, `1M`, `400K`). */
export function formatContextLengthLabel(tokens: number): string {
  const preset = CONTEXT_LENGTH_PRESETS.find(item => item.tokens === tokens);
  if (preset) return preset.label;
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : Number(m.toFixed(2))}M`;
  }
  if (tokens >= 1_000) {
    const k = tokens / 1_000;
    return `${Number.isInteger(k) ? k : Number(k.toFixed(1))}K`;
  }
  return String(tokens);
}

export function isCustomContextLength(tokens: number): boolean {
  return !CONTEXT_LENGTH_PRESETS.some(item => item.tokens === tokens);
}

export const models = signal<ModelOption[]>([]);
/** Role -> configured model reference from `catalog.default_models` (e.g. `primary`, `fast`). */
export const defaultModels = signal<Record<string, string | null | undefined>>({});
/** The workspace's default when the session has not been bound to one yet. */
export const defaultModelId = signal<string | null>(null);
/** `sessionKey` → the model the host reported or the user picked in this surface. */
export const sessionModels = signal<Record<string, string>>({});
/** `sessionKey` → explicit context length in tokens reported by host or picked here (`null`/absent = default 300K). */
export const sessionContextLengths = signal<Record<string, number | null>>({});
/** `sessionKey` → pool id when the session is bound to a model pool. */
const sessionPoolIds = signal<Record<string, string>>({});
export const modelPickerOpen = signal(false);

/** Monotonic write counter per `sessionKey` so an in-flight read cannot overwrite a newer pick. */
const sessionWriteGen: Record<string, number> = {};
/** `sessionKey`s whose `get_session_model_target` has already been read for this workspace. */
const targetReadFor = new Set<string>();
let modelEventsSubscribed = false;
let modelScopeRevision = 0;
let modelCatalogTicket = 0;

function bumpWriteGen(key: string): number {
  const next = (sessionWriteGen[key] ?? 0) + 1;
  sessionWriteGen[key] = next;
  return next;
}

function setSessionModelBinding(
  key: string,
  sessionId: string,
  modelRef: string,
  poolId?: string | null,
): void {
  sessionModels.update(current => (current[key] === modelRef ? current : { ...current, [key]: modelRef }));
  if (poolId) {
    sessionPoolIds.update(current => (current[key] === poolId ? current : { ...current, [key]: poolId }));
  } else if (key in sessionPoolIds()) {
    sessionPoolIds.update(current => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }
  sessions.update(rows => {
    let changed = false;
    const next = rows.map(row => {
      if (row.sessionId !== sessionId || row.modelName === modelRef) return row;
      changed = true;
      return { ...row, modelName: modelRef };
    });
    return changed ? next : rows;
  });
}

function extractTargetModel(target: SessionModelTargetResponse): { modelRef: string | null; poolId: string | null } {
  const selection = target.selection;
  if (selection && typeof selection === "object") {
    if (selection.kind === "model") {
      const ref = typeof selection.model_ref === "string" ? selection.model_ref.trim() : "";
      if (ref) return { modelRef: ref, poolId: null };
    } else if (selection.kind === "pool") {
      const poolId = typeof selection.pool_id === "string" ? selection.pool_id.trim() : "";
      const boundModel = typeof target.binding?.modelId === "string" ? target.binding.modelId.trim() : "";
      return { modelRef: boundModel || poolId || null, poolId: poolId || null };
    }
  }
  const legacyModel = typeof target.modelId === "string" ? target.modelId.trim() : "";
  return { modelRef: legacyModel || null, poolId: null };
}

function subscribeModelEvents(): void {
  if (modelEventsSubscribed) return;
  modelEventsSubscribed = true;
  listenEvent<{ sessionId?: string; newModelId?: string }>(
    "agentic://session-model-fallback-applied",
    (payload, meta) => {
      const sid = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
      const nextModel = typeof payload?.newModelId === "string" ? payload.newModelId.trim() : "";
      if (!sid || !nextModel) return;
      const key = sessionKey(sid, meta?.origin);
      bumpWriteGen(key);
      targetReadFor.add(key);
      setSessionModelBinding(key, sid, nextModel, null);
    },
  );
  listenEvent<{ sessionId?: string }>(
    "agentic://session-reasoning-preset-auto-cleared",
    (payload, meta) => {
      const sid = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
      if (!sid) return;
      const key = sessionKey(sid, meta?.origin);
      applyReasoningToSession(key, null);
    },
  );
}

const SYMBOLIC_PRIMARY_ROLES = new Set(["", "primary", "auto", "default"]);

function findOption(ref: string | null | undefined): ModelOption | undefined {
  if (!ref) return undefined;
  const list = models();
  return (
    list.find(option => option.id === ref) ??
    list.find(option => option.configId === ref) ??
    list.find(option => option.modelName === ref)
  );
}

function canonicalModelRef(ref: string): string {
  // A model reference projected by `fleet_models` is already the authoritative wire ref.
  const fleet = fleetChoiceOf(ref);
  if (fleet) return fleet.choice.modelRef;
  return findOption(ref)?.id ?? ref;
}

/**
 * Resolves symbolic session roles (`"primary"`, `"fast"`, `"auto"`, `"default"`)
 * against `catalog.default_models` so the composer shows the real configured
 * model name instead of a raw internal role string.
 */
export function resolveModelRef(raw: string | null | undefined): string | null {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return defaultModelId();

  // Keep fleet-projected refs intact so local/remote fleet rows match session bindings.
  const fleet = fleetChoiceOf(trimmed);
  if (fleet) return fleet.choice.modelRef;

  // An explicit configured model whose ID literally equals a role name wins first.
  const direct = findOption(trimmed);
  if (direct) return direct.id;

  const lower = trimmed.toLowerCase();
  const defaults = defaultModels();
  if (SYMBOLIC_PRIMARY_ROLES.has(lower)) {
    const primaryRef = defaults.primary;
    const primaryMatch = findOption(primaryRef);
    if (primaryMatch) return primaryMatch.id;
    return defaultModelId() ?? (primaryRef && primaryRef.trim() ? primaryRef.trim() : null);
  }
  if (lower === "fast") {
    const fastRef = defaults.fast ?? defaults.primary;
    const fastMatch = findOption(fastRef);
    if (fastMatch) return fastMatch.id;
    return defaultModelId() ?? (fastRef && fastRef.trim() ? fastRef.trim() : null);
  }

  // Unknown session-only model id stays verbatim so the user sees what the session ran on.
  return trimmed;
}

export interface SessionModelTarget {
  sessionId: string | null;
  deviceId?: string;
  workspaceId?: string | null;
}

function resolveTarget(target?: SessionModelTarget): {
  sessionId: string | null;
  deviceId: string;
  key: string | null;
  workspaceId: string | null;
} {
  if (!target) {
    const sessionId = activeSessionId();
    return {
      sessionId,
      deviceId: activeSessionDevice(),
      key: activeSessionKey() ?? (sessionId ? sessionKey(sessionId) : null),
      workspaceId: activeWorkspaceId(),
    };
  }
  const sessionId = target.sessionId;
  const deviceId = target.deviceId ?? activeSessionDevice();
  return {
    sessionId,
    deviceId,
    key: sessionId ? sessionKey(sessionId, deviceId) : null,
    workspaceId: target.workspaceId !== undefined ? target.workspaceId : activeWorkspaceId(),
  };
}

export function modelIdForSession(sessionId: string | null, deviceId?: string): string | null {
  if (!sessionId) return resolveModelRef(defaultModelId());
  const key = sessionKey(sessionId, deviceId ?? activeSessionDevice());
  const raw = sessionModels()[key] ?? boundModelOf(sessionId, deviceId ?? activeSessionDevice()) ?? defaultModelId();
  return resolveModelRef(raw);
}

export function modelTextForSession(sessionId: string | null, deviceId?: string): { label: string; detail: string } {
  const id = modelIdForSession(sessionId, deviceId);
  if (!id) return { label: "default model", detail: "" };
  const sessionDevice = deviceId ?? activeSessionDevice();
  const owner = modelCatalogTarget(id, sessionDevice);
  const device = fleetModelGroups()?.find(group => group.deviceId === owner.deviceId);
  const choice = device?.models.find(model => model.modelId === owner.modelId);
  if (device && choice) {
    const text = fleetModelText(choice);
    return owner.deviceId === sessionDevice ? text : { label: `${text.label} · ${device.name}`, detail: text.detail };
  }
  const match = findOption(id);
  if (match) return { label: match.label, detail: match.detail };
  return { label: id, detail: "" };
}

export const activeModelId = computed<string | null>(() =>
  modelIdForSession(activeSessionId(), activeSessionDevice()),
);

/** The model the host already has this session on, from its own record. */
function boundModelOf(sessionId: string, deviceId?: string): string | undefined {
  const name = sessions().find(
    row => row.sessionId === sessionId && (!fleetActive() || !row.deviceId || !deviceId || row.deviceId === deviceId),
  )?.modelName;
  return name && name.trim() ? name.trim() : undefined;
}

const activeModelText = computed<{ label: string; detail: string }>(() =>
  modelTextForSession(activeSessionId(), activeSessionDevice()),
);

/** The session's model as the composer badge names it: the model, and the device for another device's. */
export const activeModelLabel = computed<string>(() => activeModelText().label);

/** The secondary text of the session's model (its provider), for the badge's tooltip. */
export const activeModelDetail = computed<string>(() => activeModelText().detail);

/** What the picker offers: a model that cannot chat is not a choice here. */
export const chatModels = computed<ModelOption[]>(() => models().filter(option => option.chat));

function projectionToChoices(projection: ReasoningCatalogProjection | null | undefined): ReasoningChoice[] | null {
  if (!projection || typeof projection !== "object") return null;
  if (projection.status === "unsupported") return [];
  return (projection.presets ?? [])
    .filter(preset => preset && preset.id)
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
    .map(preset => ({ ...preset, label: preset.label || preset.id, actions: preset.actions ?? [] }));
}

/** Loads the catalog once per workspace; the composer asks on mount. */
export function ensureModelsLoaded(): void {
  subscribeModelEvents();
  void refreshFleetModels();
  if (models().length) return;
  // A host without a catalog leaves the composer on its default model instead of
  // showing a failure banner for a picker the user did not ask for.
  void loadModels().catch(() => undefined);
}

export async function loadModels(): Promise<void> {
  const deviceId = deviceContext();
  const scope = modelScopeRevision;
  const ticket = ++modelCatalogTicket;
  await runStep(
    async () => {
      const catalog = await getModelCatalog({ target: deviceId || undefined });
      if (ticket !== modelCatalogTicket || scope !== modelScopeRevision || deviceId !== deviceContext()) return;
      const { rawEntries, options } = modelOptionsFromCatalog(catalog);
      const primaryRef = catalog?.default_models?.primary ?? null;
      const preferred = catalog?.mode_default_model_id ?? primaryRef;
      models.set(options);
      defaultModels.set({ ...(catalog?.default_models ?? {}) });

      // Seed embedded reasoning projections straight from `get_ai_model_catalog`
      // so real Tauri hosts need zero extra `get_config`/`project_*` IPCs.
      const embeddedReasoning: Record<string, ReasoningChoice[]> = {};
      for (let index = 0; index < rawEntries.length; index += 1) {
        const choices = projectionToChoices(rawEntries[index].reasoning);
        if (choices !== null) {
          embeddedReasoning[reasoningCacheKey(options[index].id, deviceId)] = choices;
          if (options[index].configId && options[index].configId !== options[index].id) {
            embeddedReasoning[reasoningCacheKey(options[index].configId, deviceId)] = choices;
          }
        }
      }
      if (Object.keys(embeddedReasoning).length > 0) {
        reasoningByModel.update(current => ({ ...current, ...embeddedReasoning }));
      }

      const usable = preferred
        ? options.find(option => option.id === preferred || option.configId === preferred || option.modelName === preferred)?.id ?? null
        : null;
      defaultModelId.set(usable ?? options.find(option => option.chat)?.id ?? null);
    },
    { trackBusy: false, clearError: false },
  );
}

function modelOptionsFromCatalog(catalog: ModelCatalog | null | undefined) {
  const rawEntries = (catalog?.models ?? []).filter(entry => entry && entry.enabled !== false && (entry.id || entry.model_name));
  const primaryRef = catalog?.default_models?.primary;
  // A legacy catalog can address its default by model name while real hosts key the update by config ID.
  const legacyModelNameKeying = Boolean(primaryRef && rawEntries.some(entry => entry.model_name === primaryRef && entry.id !== primaryRef));
  return { rawEntries, options: rawEntries.map(entry => optionOf(entry, legacyModelNameKeying)) };
}

export async function readChatModelsForDevice(deviceId: string): Promise<ModelOption[]> {
  const catalog = await getModelCatalog({ target: deviceId || undefined });
  return modelOptionsFromCatalog(catalog).options.filter(option => option.chat);
}

function optionOf(entry: ModelCatalogEntry, legacyModelNameKeying: boolean): ModelOption {
  const capabilities = Array.isArray(entry.capabilities) ? entry.capabilities : [];
  const configId = entry.id || entry.model_name;
  const modelName = entry.model_name || entry.id;
  return {
    id: legacyModelNameKeying ? modelName : configId,
    configId,
    configName: entry.name || "",
    modelName,
    label: entry.label || entry.name || modelName,
    detail: entry.label ? entry.detail ?? "" : entry.provider ?? "",
    provider: entry.provider ?? "",
    chat:
      capabilities.length === 0 ||
      capabilities.includes("text_chat") ||
      capabilities.includes("chat"),
    ...(typeof entry.context_window === "number" && entry.context_window > 0
      ? { contextWindow: entry.context_window }
      : {}),
  };
}

export interface ChooseModelOptions {
  /** Explicit reasoning preset (`null` = model default); omitted defaults to `"high"` when offered. */
  reasoningPreset?: string | null;
  /** Explicit context length in tokens; omitted keeps session's current length (or 300K default). */
  contextWindowOverride?: number | null;
  /** Keep the model picker open after applying (used when adjusting settings inside the submenu). */
  keepOpen?: boolean;
}

/** Returns the default `"high"` preset id if the model offers it, otherwise `null`. */
export function defaultReasoningPresetFor(
  modelId: string,
  choices?: ReasoningChoice[] | null,
  deviceId?: string,
): string | null {
  const list = choices ?? cachedReasoningFor(modelId, deviceId);
  if (!Array.isArray(list) || list.length === 0) return null;
  const high = list.find(choice => choice.id.toLowerCase() === "high");
  return high ? high.id : null;
}

/** Explicit session context length if set, or the default `300K` (`300_000`) tokens. */
export function contextLengthForSession(sessionId: string | null, deviceId?: string): number {
  if (!sessionId) return DEFAULT_SESSION_CONTEXT_TOKENS;
  const key = sessionKey(sessionId, deviceId ?? activeSessionDevice());
  const stored = sessionContextLengths()[key];
  return typeof stored === "number" && stored > 0 ? stored : DEFAULT_SESSION_CONTEXT_TOKENS;
}

/** Explicit stored context length for a session, or `null` when not overridden yet. */
export function explicitContextLengthForSession(sessionId: string | null, deviceId?: string): number | null {
  if (!sessionId) return null;
  const key = sessionKey(sessionId, deviceId ?? activeSessionDevice());
  const stored = sessionContextLengths()[key];
  return typeof stored === "number" && stored > 0 ? stored : null;
}

export const activeContextLength = computed<number>(() =>
  contextLengthForSession(activeSessionId(), activeSessionDevice()),
);

export const activeContextLengthLabel = computed<string>(() =>
  formatContextLengthLabel(activeContextLength()),
);

function applyContextLengthToSession(key: string, tokens: number | null): void {
  sessionContextLengths.update(current => (current[key] === tokens ? current : { ...current, [key]: tokens }));
}

/** Binds the target (or active) session to a model, with default `high` reasoning and `300K` context length when unspecified. */
export async function chooseModel(
  modelId: string,
  target?: SessionModelTarget,
  options?: ChooseModelOptions,
): Promise<void> {
  const { sessionId, deviceId, key, workspaceId } = resolveTarget(target);
  if (!options?.keepOpen) modelPickerOpen.set(false);
  if (!sessionId || !key) return;
  const release = beginModelSave(key);
  if (!release) return;
  const route = { target: deviceId || undefined };
  const resolved = deviceId === deviceContext() ? canonicalModelRef(modelId) : modelId;
  const wasPool = Boolean(sessionPoolIds()[key]);

  // Determine the reasoning preset to apply:
  // - If explicitly requested (e.g. picked from the model's submenu), honor it when valid (or null for default).
  // - Otherwise (direct model pick), default to `"high"` when the model is known to offer it;
  //   if reasoning choices haven't been loaded yet (e.g. mobile tap without hover), load them and
  //   apply default `"high"` once known as long as no newer write superseded this pick.
  const explicitReasoning = Boolean(options && "reasoningPreset" in options);
  const knownChoices = cachedReasoningFor(resolved, deviceId);
  let sendReasoning = false;
  let preset: string | null = null;
  if (explicitReasoning) {
    const requested = options?.reasoningPreset ?? null;
    if (requested === null || reasoningOfferedFor(resolved, deviceId, requested)) {
      sendReasoning = true;
      preset = requested;
    }
  } else if (Array.isArray(knownChoices)) {
    const defaultHigh = defaultReasoningPresetFor(resolved, knownChoices, deviceId);
    if (defaultHigh !== null) {
      sendReasoning = true;
      preset = defaultHigh;
    } else {
      const currentReasoning = reasoningIdForSession(sessionId, deviceId);
      if (reasoningOfferedFor(resolved, deviceId, currentReasoning)) {
        sendReasoning = true;
        preset = currentReasoning;
      }
    }
  }

  const effectiveContext =
    options && "contextWindowOverride" in options
      ? options.contextWindowOverride ?? DEFAULT_SESSION_CONTEXT_TOKENS
      : contextLengthForSession(sessionId, deviceId);

  const scope = modelScopeRevision;
  const write = bumpWriteGen(key);
  let saved = false;
  try {
    await runStep(async () => {
      if (wasPool) {
        await updateSessionModelTarget({
          sessionId,
          selection: { kind: "model", model_ref: resolved },
          ...(workspaceId ? { workspaceId } : {}),
          includeInternal: false,
        }, route);
        await updateSessionModel({
          sessionId,
          modelName: resolved,
          ...(sendReasoning ? { reasoningPreset: preset } : {}),
          contextWindowOverride: effectiveContext,
          ...(workspaceId ? { workspaceId } : {}),
          includeInternal: false,
        }, route);
      } else {
        await updateSessionModel({
          sessionId,
          modelName: resolved,
          // A preset the new model does not offer would be refused as a pair, so only
          // send reasoningPreset when it is `null` or known to be offered by this model.
          ...(sendReasoning ? { reasoningPreset: preset } : {}),
          contextWindowOverride: effectiveContext,
          ...(workspaceId ? { workspaceId } : {}),
          includeInternal: false,
        }, route);
      }
      if (scope !== modelScopeRevision || sessionWriteGen[key] !== write) return;
      saved = true;
      targetReadFor.add(key);
      setSessionModelBinding(key, sessionId, resolved, null);
      applyReasoningToSession(key, sendReasoning ? preset : null);
      applyContextLengthToSession(key, effectiveContext);
    });
  } finally {
    release();
  }

  // When a model is selected directly before its reasoning catalog has loaded (such as on
  // touch devices without hover), load its presets and apply default `"high"` if supported.
  if (saved && !explicitReasoning && !Array.isArray(knownChoices)) {
    void ensureReasoningChoicesForModel(resolved, deviceId).then(async loadedChoices => {
      if (scope !== modelScopeRevision || (sessionWriteGen[key] ?? 0) !== write) return;
      const defaultHigh = defaultReasoningPresetFor(resolved, loadedChoices, deviceId);
      if (defaultHigh === null) return;
      const followRelease = beginModelSave(key);
      if (!followRelease) return;
      const followGen = bumpWriteGen(key);
      try {
        await runStep(
          async () => {
            await updateSessionModel({
              sessionId,
              modelName: resolved,
              reasoningPreset: defaultHigh,
              contextWindowOverride: effectiveContext,
              ...(workspaceId ? { workspaceId } : {}),
              includeInternal: false,
            }, route);
            if (scope === modelScopeRevision && (sessionWriteGen[key] ?? 0) === followGen) {
              applyReasoningToSession(key, defaultHigh);
            }
          },
          { trackBusy: false, clearError: false },
        );
      } finally {
        followRelease();
      }
    });
  }
}

/** One reasoning setting a model offers, as the composer draws it. */
export type ReasoningChoice = ReasoningPresetDescriptor;

export function reasoningEffort(preset: ReasoningChoice): string | undefined {
  if (preset.effective_effort) return preset.effective_effort;
  if (preset.actions.some(action => action.type === "request_patch")) return undefined;
  const toggle = preset.actions.find(action => action.type === "toggle");
  if (toggle && !toggle.enabled) return "off";
  const effort = preset.actions.find(action => action.type === "effort");
  if (typeof effort?.value === "string") return effort.value;
  if (preset.actions.some(action => action.type === "budget_tokens")) return undefined;
  if (toggle) return "on";
  return preset.source === "model_config" ? undefined : preset.id;
}

export function isAutomaticReasoning(preset: ReasoningChoice): boolean {
  return ["on", "auto", "adaptive"].includes(reasoningEffort(preset) ?? "") &&
    (preset.source !== "model_config" || ["on", "auto", "adaptive"].includes(preset.id));
}

export function reasoningPresetLabel(preset: ReasoningChoice): string {
  if (isAutomaticReasoning(preset)) return tr("common.auto");
  if (preset.source === "model_config") return preset.label;
  switch (reasoningEffort(preset)) {
    case "off": case "none": return tr("sessions.reasoningOff");
    case "minimal": return tr("sessions.reasoningMinimal");
    case "low": return tr("sessions.reasoningLow");
    case "medium": return tr("sessions.reasoningMedium");
    case "high": return tr("sessions.reasoningHigh");
    case "xhigh": return tr("sessions.reasoningExtraHigh");
    case "max": return tr("sessions.reasoningMax");
    default: return preset.label;
  }
}

/** `sessionKey` → the reasoning setting the host reported or this surface wrote. */
export const sessionReasoning = signal<Record<string, string | null>>({});
/** Device and model id → offered settings; `null` while that owner answers. */
export const reasoningByModel = signal<Record<string, ReasoningChoice[] | null>>({});
export const reasoningPickerOpen = signal(false);
const modelSaves = signal<ReadonlySet<string>>(new Set());
const reasoningLoads = new Map<string, Promise<void>>();

function beginModelSave(key: string): (() => void) | null {
  if (modelSaves().has(key)) return null;
  modelSaves.update(pending => new Set([...pending, key]));
  return () => modelSaves.update(pending => {
    const next = new Set(pending);
    next.delete(key);
    return next;
  });
}

function modelCatalogTarget(modelId: string, deviceId: string): { modelId: string; deviceId: string } {
  const fleet = /^fleet:([^/]+)\/(.+)$/.exec(modelId);
  return fleet ? { deviceId: fleet[1], modelId: fleet[2] } : { deviceId, modelId };
}

function reasoningCacheKey(modelId: string, deviceId?: string): string {
  const targetDevice = deviceId ?? activeSessionDevice() ?? deviceContext();
  const owner = modelCatalogTarget(modelId, targetDevice);
  return JSON.stringify([owner.deviceId, owner.modelId]);
}

function cachedReasoningFor(modelId: string, deviceId?: string): ReasoningChoice[] | null | undefined {
  const targetDevice = deviceId ?? activeSessionDevice() ?? deviceContext();
  const owner = modelCatalogTarget(modelId, targetDevice);
  const map = reasoningByModel();
  const primaryKey = JSON.stringify([owner.deviceId, owner.modelId]);
  if (primaryKey in map) return map[primaryKey];
  if (owner.deviceId === deviceContext() || owner.deviceId === entryDeviceId()) {
    const resolved = canonicalModelRef(owner.modelId);
    const resolvedKey = JSON.stringify([owner.deviceId, resolved]);
    if (resolvedKey in map) return map[resolvedKey];
    if (deviceContext() !== owner.deviceId) {
      const localKey = JSON.stringify([deviceContext(), resolved]);
      if (localKey in map) return map[localKey];
      const rawLocalKey = JSON.stringify([deviceContext(), owner.modelId]);
      if (rawLocalKey in map) return map[rawLocalKey];
    }
  }
  return undefined;
}

export interface ModelContextView {
  key: string;
  modelId: string;
  configId: string;
  deviceId: string;
  contextWindow?: number;
  editable: boolean;
}

export function modelContextOf(ref: string | null, deviceId: string): ModelContextView | null {
  if (!ref) return null;
  const owner = modelCatalogTarget(ref, deviceId);
  const local = owner.deviceId === deviceContext() ? findOption(owner.modelId) : undefined;
  const device = fleetModelGroups()?.find(group => group.deviceId === owner.deviceId);
  const projected = device?.models.find(model => model.modelId === owner.modelId || model.modelId === local?.configId);
  const configId = local?.configId || projected?.modelId || "";
  return {
    key: JSON.stringify([owner.deviceId, configId || owner.modelId]), modelId: owner.modelId, configId, deviceId: owner.deviceId,
    contextWindow: local?.contextWindow ?? projected?.contextWindow,
    editable: Boolean(configId && (device ? device.online && projected?.selectable : local?.chat)),
  };
}

export function modelContextForSession(target?: SessionModelTarget): ModelContextView | null {
  const { sessionId, deviceId, key } = resolveTarget(target);
  const context = modelContextOf(modelIdForSession(sessionId, deviceId), deviceId || deviceContext());
  if (context && key && sessionPoolIds()[key]) return { ...context, editable: false };
  return context;
}

const savingContexts = signal<ReadonlySet<string>>(new Set());

export function modelContextPending(context: ModelContextView | null): boolean {
  return Boolean(context && savingContexts().has(context.key));
}

export async function saveComposerModelContext(context: ModelContextView, capacity: number) {
  if (!context.editable || modelContextPending(context)) throw new Error(tr("sessions.modelContextSaveFailed"));
  savingContexts.update(keys => new Set([...keys, context.key]));
  const scope = modelScopeRevision;
  try {
    const saved = await saveModelContextWindow(context.deviceId, context.configId, capacity);
    if (context.deviceId === deviceContext() && models().some(option => option.configId === context.configId)) {
      modelCatalogTicket += 1;
      models.update(options => options.map(option => option.configId === context.configId
        ? { ...option, contextWindow: saved.contextWindow } : option));
    }
    const groups = fleetModelGroups();
    if (groups?.some(device => device.deviceId === context.deviceId)) {
      fleetModelsTicket += 1;
      fleetModelGroups.set(groups.map(device => device.deviceId === context.deviceId ? {
        ...device,
        models: device.models.map(model => model.modelId === context.configId
          ? { ...model, contextWindow: saved.contextWindow } : model),
      } : device));
    }
    // The host compiles its reasoning presets against the model's output limit.
    // The context edit can lower that limit, so the open picker needs fresh options.
    const presetKeys = [...new Set([context.modelId, context.configId].map(id => reasoningCacheKey(id, context.deviceId)))];
    if (scope === modelScopeRevision && presetKeys.some(key => reasoningByModel()[key] !== undefined)) {
      const choices = await reasoningChoicesFor(context.configId, context.deviceId, true).catch(() => [] as ReasoningChoice[]);
      if (scope === modelScopeRevision) {
        reasoningByModel.update(current => ({ ...current, ...Object.fromEntries(presetKeys.map(key => [key, choices])) }));
      }
    }
    return saved;
  } finally {
    savingContexts.update(keys => {
      const next = new Set(keys);
      next.delete(context.key);
      return next;
    });
  }
}

const inFlightReasoningLoads = new Map<string, Promise<ReasoningChoice[]>>();

/** Returns the cached reasoning choices for any model id (empty while loading or unsupported). */
export function reasoningChoicesForModel(modelId: string | null | undefined, deviceId?: string): ReasoningChoice[] {
  if (!modelId) return [];
  return cachedReasoningFor(modelId, deviceId) ?? [];
}

/** True while reasoning choices for `modelId` are currently being fetched from the host. */
export function isReasoningLoadingForModel(modelId: string | null | undefined, deviceId?: string): boolean {
  if (!modelId) return false;
  return cachedReasoningFor(modelId, deviceId) === null;
}

/** Ensures reasoning presets for `modelId` are loaded into `reasoningByModel` (deduped). */
export function ensureReasoningChoicesForModel(modelId: string, deviceId?: string): Promise<ReasoningChoice[]> {
  const targetDevice = deviceId ?? activeSessionDevice() ?? deviceContext();
  const existing = cachedReasoningFor(modelId, targetDevice);
  if (Array.isArray(existing)) return Promise.resolve(existing);
  const cacheKey = reasoningCacheKey(modelId, targetDevice);
  const pending = inFlightReasoningLoads.get(cacheKey);
  if (pending) return pending;
  const scope = modelScopeRevision;
  reasoningByModel.update(current => (current[cacheKey] === undefined ? { ...current, [cacheKey]: null } : current));
  const task = reasoningChoicesFor(modelId, targetDevice)
    .catch(() => [] as ReasoningChoice[])
    .then(choices => {
      if (scope === modelScopeRevision) {
        reasoningByModel.update(current => ({ ...current, [cacheKey]: choices }));
      }
      inFlightReasoningLoads.delete(cacheKey);
      return choices;
    });
  inFlightReasoningLoads.set(cacheKey, task);
  return task;
}

/**
 * `sessionKey` → the model whose reasoning was already read. The composer's effect
 * recomputes the active model whenever the session catalog moves, and a host round
 * trip per pass would be paid for nothing.
 */
const reasoningReadFor: Record<string, string> = {};

export function reasoningIdForSession(sessionId: string | null, deviceId?: string): string | null {
  if (!sessionId) return null;
  const key = sessionKey(sessionId, deviceId ?? activeSessionDevice());
  return sessionReasoning()[key] ?? null;
}

export function reasoningChoicesForSession(sessionId: string | null, deviceId?: string): ReasoningChoice[] {
  if (sessionId && sessionPoolIds()[sessionKey(sessionId, deviceId ?? activeSessionDevice())]) return [];
  const modelId = modelIdForSession(sessionId, deviceId);
  if (!modelId) return [];
  return cachedReasoningFor(modelId, deviceId ?? activeSessionDevice()) ?? [];
}

export function reasoningLabelForSession(sessionId: string | null, deviceId?: string): string {
  const id = reasoningIdForSession(sessionId, deviceId);
  if (!id) return tr("common.auto");
  const match = reasoningChoicesForSession(sessionId, deviceId).find(choice => choice.id === id);
  return match ? reasoningPresetLabel(match) : id;
}

/**
 * What the next turn runs at, `null` for the model's own default. A session this
 * surface never read a setting for reads as the default rather than as an unknown
 * value, which is also how the host reports a session nobody has set.
 */
export const activeReasoningId = computed<string | null>(() =>
  reasoningIdForSession(activeSessionId(), activeSessionDevice()),
);

export const activeReasoningChoices = computed<ReasoningChoice[]>(() =>
  reasoningChoicesForSession(activeSessionId(), activeSessionDevice()),
);

export const activeReasoningLabel = computed<string>(() =>
  reasoningLabelForSession(activeSessionId(), activeSessionDevice()),
);

function reasoningOfferedFor(modelId: string, deviceId: string, presetId: string | null): boolean {
  const choices = cachedReasoningFor(modelId, deviceId);
  // Until the host answers, the pair is left alone: sending a preset it may not
  // know would make the model change fail, which is worse than not carrying it.
  if (choices === null || choices === undefined) return false;
  return presetId !== null && choices.some(choice => choice.id === presetId);
}

function applyReasoningToSession(key: string, preset: string | null): void {
  sessionReasoning.update(current => ({ ...current, [key]: preset }));
}

/**
 * Reads the session's authoritative model & reasoning binding from the host
 * (`get_session_model_target`) and ensures reasoning presets for that model are
 * loaded. Reading the target first guarantees the composer shows the session's
 * actual bound model (even on fleet connections where `FleetSession` omits
 * `modelName`) and loads reasoning options for that real model.
 */
export async function ensureReasoningLoaded(target?: SessionModelTarget): Promise<void> {
  const { sessionId, deviceId, key, workspaceId } = resolveTarget(target);
  if (!sessionId || !key) return;
  const pending = reasoningLoads.get(key);
  if (pending) return pending;
  const needTarget = !targetReadFor.has(key);
  const initialModelId = modelIdForSession(sessionId, deviceId);
  const needReasoningForInitial =
    !needTarget && Boolean(initialModelId) && reasoningReadFor[key] !== initialModelId;
  if (!needTarget && !needReasoningForInitial) return;

  if (needTarget) targetReadFor.add(key);
  const scope = modelScopeRevision;
  const writeGenBefore = sessionWriteGen[key] ?? 0;

  const loading = runStep(
    async () => {
      if (needTarget) {
        const result = await getSessionModelTarget({
          sessionId,
          ...(workspaceId ? { workspaceId } : {}),
        }, { target: deviceId || undefined }).catch(() => null);
        if (scope !== modelScopeRevision) return;
        // Never overwrite an explicit user pick made while this read was in flight.
        if (result && (sessionWriteGen[key] ?? 0) === writeGenBefore) {
          const { modelRef, poolId } = extractTargetModel(result);
          if (modelRef) {
            setSessionModelBinding(key, sessionId, modelRef, poolId);
          }
          // A host older than the field omits it; that is not a session set to the
          // default, so nothing is written for it.
          if (result.reasoningPreset !== undefined) {
            applyReasoningToSession(key, result.reasoningPreset ?? null);
          }
          if (result.contextWindowOverride !== undefined) {
            applyContextLengthToSession(
              key,
              typeof result.contextWindowOverride === "number" && result.contextWindowOverride > 0
                ? result.contextWindowOverride
                : null,
            );
          }
        }
      }

      const effectiveModelId = modelIdForSession(sessionId, deviceId);
      if (!effectiveModelId) return;
      if (reasoningReadFor[key] === effectiveModelId && Array.isArray(cachedReasoningFor(effectiveModelId, deviceId))) {
        return;
      }
      reasoningReadFor[key] = effectiveModelId;
      if (cachedReasoningFor(effectiveModelId, deviceId) === undefined) {
        await ensureReasoningChoicesForModel(effectiveModelId, deviceId);
      }
    },
    { trackBusy: false, clearError: false },
  );
  reasoningLoads.set(key, loading);
  try { await loading; }
  finally { if (reasoningLoads.get(key) === loading) reasoningLoads.delete(key); }
}

async function storedModelEntry(modelId: string): Promise<StoredModel | null> {
  if (!storedModels().length) {
    await loadStoredModels().catch(() => undefined);
  }
  const opt = findOption(modelId);
  const direct = storedModels().find(
    entry =>
      entry.id === modelId ||
      entry.model_name === modelId ||
      (opt ? entry.id === opt.configId || entry.model_name === opt.modelName : false),
  );
  if (direct) return direct;
  const defaults = (await getConfig("ai.default_models", true).catch(() => null)) as
    | Record<string, string | null>
    | null;
  const resolved = defaults?.[modelId];
  if (!resolved) return null;
  return storedModels().find(entry => entry.id === resolved || entry.model_name === resolved) ?? null;
}

/** The presets a model's provider compiles its reasoning into (fallback when catalog omitted `reasoning`). */
async function reasoningChoicesFor(modelId: string, deviceId: string, refreshCatalog = false): Promise<ReasoningChoice[]> {
  const owner = modelCatalogTarget(modelId, deviceId);
  const route = { target: owner.deviceId || undefined };
  const remoteOwner = owner.deviceId !== deviceContext();
  if (remoteOwner || refreshCatalog) {
    const catalog = await getModelCatalog(route).catch(() => null);
    const entry = catalog?.models?.find(model => model.id === owner.modelId || model.model_name === owner.modelId);
    if (entry) {
      const choices = projectionToChoices(entry.reasoning);
      if (choices !== null) return choices;
      if (remoteOwner) {
        return projectionToChoices(await projectAiModelReasoningCatalog({
          provider: entry.provider, modelName: entry.model_name, baseUrl: entry.base_url ?? "",
          contextWindow: entry.context_window, reasoning: {},
        }, route)) ?? [];
      }
    }
  }
  const entry = await storedModelEntry(owner.modelId);
  if (entry) {
    const block = entry.reasoning;
    const projection = await projectAiModelReasoningCatalog({
      provider: entry.provider,
      modelName: entry.model_name,
      baseUrl: entry.base_url ?? "",
      ...(typeof entry.context_window === "number" ? { contextWindow: entry.context_window } : {}),
      ...(typeof entry.max_tokens === "number" ? { maxTokens: entry.max_tokens } : {}),
      reasoning: block && typeof block === "object" ? (block as Record<string, unknown>) : {},
    }, route);
    return projectionToChoices(projection) ?? [];
  }
  const fleetMatch = fleetChoiceOf(modelId);
  if (!fleetMatch) return [];
  const projection = await projectAiModelReasoningCatalog({
    provider: fleetMatch.choice.provider,
    modelName: fleetMatch.choice.modelName || fleetMatch.choice.modelId,
    baseUrl: "",
    ...(typeof fleetMatch.choice.contextWindow === "number" ? { contextWindow: fleetMatch.choice.contextWindow } : {}),
    reasoning: {},
  }, route);
  return projectionToChoices(projection) ?? [];
}

/** Sets the reasoning the next turn runs at, alongside the model it is bound to. */
export function modelChangePending(target?: SessionModelTarget): boolean {
  const { key } = resolveTarget(target);
  return key !== null && modelSaves().has(key);
}

export async function chooseReasoning(
  presetId: string | null,
  target?: SessionModelTarget,
  options?: { keepOpen?: boolean },
): Promise<boolean> {
  const { sessionId, deviceId, key, workspaceId } = resolveTarget(target);
  reasoningPickerOpen.set(false);
  if (!options?.keepOpen) modelPickerOpen.set(false);
  if (!sessionId || !key) return false;
  const release = beginModelSave(key);
  if (!release) return false;
  const pinned = { sessionId, deviceId, workspaceId };
  const scope = modelScopeRevision;
  try {
    await ensureReasoningLoaded(pinned);
    const modelId = modelIdForSession(sessionId, deviceId);
    if (!modelId || sessionPoolIds()[key] || scope !== modelScopeRevision) return false;
    if (presetId === reasoningIdForSession(sessionId, deviceId)) return true;
    if (presetId !== null && !reasoningOfferedFor(modelId, deviceId, presetId)) return false;
    const contextTokens = explicitContextLengthForSession(sessionId, deviceId);
    const write = bumpWriteGen(key);
    await updateSessionModel({
      sessionId,
      modelName: modelId,
      reasoningPreset: presetId,
      ...(contextTokens !== null ? { contextWindowOverride: contextTokens } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      includeInternal: false,
    }, { target: deviceId || undefined });
    if (scope === modelScopeRevision && sessionWriteGen[key] === write) applyReasoningToSession(key, presetId);
    return true;
  } finally {
    release();
  }
}

/** Sets the session's context length limit (in tokens) alongside its current model and reasoning setting. */
export async function chooseContextLength(
  tokens: number,
  target?: SessionModelTarget,
  options?: { modelId?: string; reasoningPreset?: string | null; keepOpen?: boolean },
): Promise<void> {
  const { sessionId, deviceId, key, workspaceId } = resolveTarget(target);
  if (!options?.keepOpen) modelPickerOpen.set(false);
  if (!sessionId || !key) return;
  const release = beginModelSave(key);
  if (!release) return;
  const route = { target: deviceId || undefined };
  const scope = modelScopeRevision;
  try {
    if (!targetReadFor.has(key)) {
      await ensureReasoningLoaded(target);
    }
    const resolvedModel = options?.modelId
      ? (deviceId === deviceContext() ? canonicalModelRef(options.modelId) : options.modelId)
      : modelIdForSession(sessionId, deviceId);
    if (!resolvedModel || scope !== modelScopeRevision) return;
    const currentModel = modelIdForSession(sessionId, deviceId);
    const switchingModel = resolvedModel !== currentModel;
    const desiredReasoning =
      options && "reasoningPreset" in options
        ? options.reasoningPreset ?? null
        : switchingModel
          ? defaultReasoningPresetFor(resolvedModel, undefined, deviceId)
          : reasoningIdForSession(sessionId, deviceId);
    const canSendReasoning =
      desiredReasoning === null || reasoningOfferedFor(resolvedModel, deviceId, desiredReasoning);

    const wasPool = Boolean(sessionPoolIds()[key]);
    const write = bumpWriteGen(key);
    await runStep(async () => {
      if (wasPool && switchingModel) {
        await updateSessionModelTarget({
          sessionId,
          selection: { kind: "model", model_ref: resolvedModel },
          ...(workspaceId ? { workspaceId } : {}),
          includeInternal: false,
        }, route);
      }
      await updateSessionModel({
        sessionId,
        modelName: resolvedModel,
        ...(canSendReasoning ? { reasoningPreset: desiredReasoning } : {}),
        contextWindowOverride: tokens,
        ...(workspaceId ? { workspaceId } : {}),
        includeInternal: false,
      }, route);
      if (scope !== modelScopeRevision || sessionWriteGen[key] !== write) return;
      targetReadFor.add(key);
      if (switchingModel) {
        setSessionModelBinding(key, sessionId, resolvedModel, null);
      }
      if (canSendReasoning) {
        applyReasoningToSession(key, desiredReasoning);
      }
      applyContextLengthToSession(key, tokens);
    });
  } finally {
    release();
  }
}

onSessionCreated(({ sessionId, deviceId, modelId }) => {
  if (!sessionId || !modelId) return;
  const key = sessionKey(sessionId, deviceId);
  setSessionModelBinding(key, sessionId, modelId, null);
});

onDefaultModelsChanged(() => {
  void loadModels().catch(() => undefined);
});

onWorkspaceChanged(() => {
  modelScopeRevision += 1;
  models.set([]);
  defaultModels.set({});
  defaultModelId.set(null);
  sessionModels.set({});
  sessionContextLengths.set({});
  sessionPoolIds.set({});
  fleetModelGroups.set(null);
  modelPickerOpen.set(false);
  // Presets belong to a model and a session belongs to a workspace, so neither
  // reading survives that change.
  reasoningPickerOpen.set(false);
  sessionReasoning.set({});
  reasoningByModel.set({});
  inFlightReasoningLoads.clear();
  reasoningLoads.clear();
  targetReadFor.clear();
  for (const key of Object.keys(reasoningReadFor)) delete reasoningReadFor[key];
  for (const key of Object.keys(sessionWriteGen)) delete sessionWriteGen[key];
  void loadModels().catch(() => undefined);
  void refreshFleetModels();
});
