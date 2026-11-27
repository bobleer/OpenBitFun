import { signal } from "nsh";
import { backendConnection, fleetActive, invokeCommand } from "../bridge";
import { fleetDeviceById, fleetWorkspaceByKey } from "../fleetStore";
import { listMcpResourceRows, readMcpResource, type McpResourceRow } from "../mcpResourcesStore";
import { workspaces } from "../state";
import type { FigureOwner } from "../toolDetailStore";
import { figureBindingValue, type BoundValue } from "./figureBindingGuest";
import type { RefreshableBinding } from "../figureBindingDeclarations";

type Server = { value: string; label: string };
type ResourceState = {
  phase: "idle" | "loading" | "choose" | "empty" | "connected" | "failed";
  servers: Server[];
  server?: string;
  rows: McpResourceRow[];
  resource?: string;
};
type Task = { timer?: ReturnType<typeof setTimeout> };
const EMPTY: ResourceState = { phase: "idle", servers: [], rows: [] };
const RESOURCE_BYTES = 256 * 1024;

function canReadFigureResources(owner: FigureOwner) {
  if (backendConnection() !== owner.connection || fleetActive() !== owner.viaFleet) return false;
  if (owner.viaFleet) {
    const device = fleetDeviceById(owner.deviceId);
    const workspace = fleetWorkspaceByKey(owner);
    return device?.hostKind === "desktop" && !!workspace &&
      (workspace.kind === "local" || workspace.kind === "assistant") &&
      !workspace.connectionId && !workspace.sshHost;
  }
  const workspace = workspaces().find(record => record.id === owner.workspaceId);
  return !!workspace && (workspace.workspaceKind === "local" || workspace.workspaceKind === "assistant") &&
    !workspace.connectionId && !workspace.sshHost;
}

function serverChoices(answer: unknown): Server[] {
  if (!Array.isArray(answer)) return [];
  return [...new Map(answer.flatMap(row => {
    if (!row || typeof row.id !== "string" || typeof row.name !== "string" ||
        row.enabled !== true || typeof row.status !== "string" ||
        !["connected", "healthy"].includes(row.status.toLowerCase())) return [];
    return [[row.id, { value: row.id, label: row.name }] as const];
  })).values()];
}

function projectContent(binding: RefreshableBinding, row: McpResourceRow, contents: unknown): BoundValue | undefined {
  if (!Array.isArray(contents)) return;
  const entry = contents.find(record => record && record.uri === row.uri) as Record<string, unknown> | undefined;
  if (!entry) return;
  const text = typeof entry.text === "string" ? entry.text : entry.content;
  if (binding.type === "tool") {
    if (typeof text !== "string" || new TextEncoder().encode(text).length > 32 * 1024) return;
    return figureBindingValue(binding, { kind: "json", value: JSON.parse(text) });
  }
  return figureBindingValue(binding, { kind: "file", value: {
    name: row.name, mimeType: entry.mimeType ?? row.mimeType, text, base64: entry.blob,
  } });
}

export function createFigureResourceBinding(
  owner: FigureOwner,
  current: () => boolean,
  publish: (name: string, value: BoundValue) => boolean,
) {
  const states = signal<Record<string, ResourceState>>({});
  const tasks = new Map<string, Task>();
  const route = owner.viaFleet ? { target: owner.deviceId } : {};
  const state = (name: string) => {
    const all = states();
    return Object.hasOwn(all, name) ? all[name] : EMPTY;
  };
  const set = (name: string, value: ResourceState) => states.update(all => ({ ...all, [name]: value }));
  const inScope = () => current() && canReadFigureResources(owner);
  const active = (name: string, task: Task) => current() && tasks.get(name) === task;

  function stop(name: string) {
    const prior = tasks.get(name);
    if (prior?.timer !== undefined) clearTimeout(prior.timer);
    tasks.delete(name);
  }

  function start(name: string) {
    stop(name);
    const task: Task = {};
    tasks.set(name, task);
    return task;
  }

  async function discover(name: string) {
    const task = start(name);
    set(name, { ...EMPTY, phase: "loading" });
    try {
      if (!inScope()) throw new Error("Figure owner workspace does not support MCP resources");
      const servers = serverChoices(await invokeCommand<unknown>("get_mcp_servers", undefined, route));
      if (!inScope()) throw new Error("Figure owner workspace changed");
      if (active(name, task)) set(name, { ...EMPTY, servers, phase: servers.length ? "choose" : "empty" });
    } catch {
      if (active(name, task)) set(name, { ...EMPTY, phase: "failed" });
    }
  }

  async function selectServer(name: string, server: string) {
    const { servers } = state(name);
    if (!servers.some(choice => choice.value === server)) return;
    const task = start(name);
    set(name, { ...EMPTY, servers, server, phase: "loading" });
    try {
      if (!inScope()) throw new Error("Figure owner workspace does not support MCP resources");
      const readable = (await listMcpResourceRows(server, true, route))
        .filter(row => row.size == null || row.size <= RESOURCE_BYTES);
      const rows = [...new Map(readable.map(row => [row.uri, row])).values()];
      if (!inScope()) throw new Error("Figure owner workspace changed");
      if (active(name, task)) set(name, { servers, server, rows, phase: rows.length ? "choose" : "empty" });
    } catch {
      if (active(name, task)) set(name, { ...EMPTY, servers, server, phase: "failed" });
    }
  }

  function selectResource(name: string, binding: RefreshableBinding, uri: string) {
    const initial = state(name);
    const server = initial.server;
    const row = initial.rows.find(choice => choice.uri === uri);
    if (!server || !row) return;
    const task = start(name);
    const selected = { ...initial, resource: uri };
    let last = "";
    async function refresh() {
      if (!active(name, task)) return;
      try {
        if (!inScope()) throw new Error("Figure owner workspace does not support MCP resources");
        const result = await readMcpResource(server!, uri, route);
        if (!active(name, task)) return;
        if (!inScope()) throw new Error("Figure owner workspace changed");
        const value = projectContent(binding, row!, result?.contents);
        if (!value) throw new Error("MCP response has no compatible advertised resource");
        const serialized = JSON.stringify(value);
        if (serialized !== last) {
          if (!publish(name, value)) throw new Error("Figure could not accept the resource value");
          last = serialized;
        }
        set(name, { ...selected, phase: "connected" });
      } catch {
        if (active(name, task)) set(name, { ...selected, phase: "failed" });
      }
      if (active(name, task)) task.timer = setTimeout(() => void refresh(), binding.refreshIntervalSeconds * 1000);
    }
    set(name, { ...selected, phase: "loading" });
    void refresh();
  }

  function disconnect(name: string) {
    stop(name);
    set(name, { ...state(name), phase: "choose", resource: undefined });
  }

  return { state, available: inScope, discover, selectServer, selectResource, disconnect, dispose: () => {
    for (const name of tasks.keys()) stop(name);
  } };
}
