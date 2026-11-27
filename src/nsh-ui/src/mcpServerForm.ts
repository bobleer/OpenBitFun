import type { MessageKey } from "./i18n";

export type McpEntry = Record<string, unknown>;
export type McpTransport = "stdio" | "streamable-http" | "sse";
export type McpFormAuth = "preserve" | "auto" | "oauth" | "token" | "headers";

export interface McpKeyValue {
  key: string;
  value?: string;
  savedValue?: string;
}

export interface McpDraft {
  originalId?: string;
  id: string;
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  env: McpKeyValue[];
  workingDirectory: string;
  url: string;
  headers: McpKeyValue[];
  auth: McpFormAuth;
  token: string;
  enabled: boolean;
  autoStart: boolean;
  startupSeconds: string;
}

export class McpFormError extends Error {
  constructor(readonly label: MessageKey, readonly field?: keyof McpDraft) { super(label); }
}

/** Raised when one of the form's fields cannot represent the stored entry faithfully. */
export class McpAdvancedEntry extends Error {
  constructor() { super("This entry has fields the form does not draw"); }
}

export function isMcpEntry(value: unknown): value is McpEntry {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const transports: Readonly<Record<string, McpTransport>> = {
  local: "stdio", stdio: "stdio", remote: "streamable-http", http: "streamable-http",
  "streamable-http": "streamable-http", streamable_http: "streamable-http", streamablehttp: "streamable-http", sse: "sse",
};

function optionalText(entry: McpEntry, key: string): string {
  const value = entry[key];
  if (value === undefined) return "";
  if (typeof value !== "string") throw new McpAdvancedEntry();
  return value;
}

function optionalFlag(entry: McpEntry, key: string, fallback: boolean): boolean {
  const value = entry[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new McpAdvancedEntry();
  return value;
}

function transportOf(entry: McpEntry): McpTransport {
  const type = optionalText(entry, "type").trim().toLowerCase();
  const explicitTransport = optionalText(entry, "transport").trim().toLowerCase();
  const explicitSource = optionalText(entry, "source").trim().toLowerCase();
  if ((type && !Object.hasOwn(transports, type))
    || (explicitTransport && (!Object.hasOwn(transports, explicitTransport) || ["local", "remote"].includes(explicitTransport)))
    || (explicitSource && !["local", "remote"].includes(explicitSource))) throw new McpAdvancedEntry();
  const legacySource = !type || type === "stdio" ? "" : type === "local" ? "local" : "remote";
  const source = explicitSource || legacySource;
  const hasCommand = Boolean(optionalText(entry, "command").trim());
  const hasUrl = Boolean(optionalText(entry, "url").trim());
  const transport = transports[explicitTransport || type] ?? (hasUrl || source === "remote" ? "streamable-http" : "stdio");
  if ((hasCommand && hasUrl) || (source === "remote" && hasCommand) || (source === "local" && hasUrl)
    || (transport === "stdio" ? hasUrl || source === "remote" : hasCommand || source === "local")) throw new McpAdvancedEntry();
  return transport;
}

function rowsFromObject(value: unknown): McpKeyValue[] {
  if (value === undefined) return [];
  if (!isMcpEntry(value)) throw new McpAdvancedEntry();
  return Object.entries(value).map(([key, savedValue]) => {
    if (typeof savedValue !== "string") throw new McpAdvancedEntry();
    return { key, savedValue };
  });
}

export function newMcpDraft(): McpDraft {
  return { id: "", name: "", transport: "streamable-http", command: "", args: [], env: [], workingDirectory: "", url: "",
    headers: [], auth: "auto", token: "", enabled: false, autoStart: false, startupSeconds: "" };
}

export function draftFromEntry(id: string, entry: McpEntry): McpDraft {
  if (!isMcpEntry(entry)) throw new McpAdvancedEntry();
  const args = entry.args ?? [];
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) throw new McpAdvancedEntry();
  const timeouts = entry.timeouts;
  if (timeouts !== undefined && !isMcpEntry(timeouts)) throw new McpAdvancedEntry();
  const startupMs = isMcpEntry(timeouts) ? timeouts.startupMs : undefined;
  if (startupMs !== undefined && (typeof startupMs !== "number" || !Number.isSafeInteger(startupMs) || startupMs <= 0)) {
    throw new McpAdvancedEntry();
  }
  const env = rowsFromObject(entry.env);
  const headers = rowsFromObject(entry.headers);
  try { rowMap(env, "env"); rowMap(headers, "headers"); }
  catch { throw new McpAdvancedEntry(); }
  return {
    originalId: id, id, name: optionalText(entry, "name") || id, transport: transportOf(entry),
    command: optionalText(entry, "command"), args: [...args] as string[], env,
    workingDirectory: optionalText(entry, "workingDirectory"), url: optionalText(entry, "url"), headers,
    auth: "preserve", token: "", enabled: optionalFlag(entry, "enabled", true),
    autoStart: optionalFlag(entry, "autoStart", optionalFlag(entry, "auto_start", true)),
    startupSeconds: startupMs === undefined ? "" : String(startupMs / 1000),
  };
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function rowMap(rows: McpKeyValue[], field: "env" | "headers"): Record<string, string> {
  const keys = new Set<string>();
  return Object.fromEntries(rows.map(row => {
    const key = row.key.trim();
    if (!key || (field === "env" ? /[=\0]/.test(key) : !HEADER_NAME.test(key))) {
      throw new McpFormError("settings.mcp.formInvalidKey", field);
    }
    const identity = field === "headers" ? key.toLowerCase() : key;
    if (keys.has(identity)) throw new McpFormError("settings.mcp.formDuplicateKey", field);
    keys.add(identity);
    const value = row.value ?? row.savedValue ?? "";
    if (field === "headers" ? /[\r\n\0]/.test(value) : value.includes("\0")) {
      throw new McpFormError("settings.mcp.formInvalidValue", field);
    }
    return [key, value];
  }));
}

function applyRemoteAuth(entry: McpEntry, draft: McpDraft, headers: Record<string, string>, validate: boolean): void {
  if (draft.auth === "preserve") return;
  if (typeof entry.oauth === "boolean") delete entry.oauth;
  entry.oauthEnabled = draft.auth === "auto" || draft.auth === "oauth";
  if (draft.auth === "headers") return;
  for (const key of Object.keys(headers)) if (key.toLowerCase() === "authorization") delete headers[key];
  if (draft.auth !== "token") return;
  const token = draft.token.trim();
  if (validate && !token) throw new McpFormError("settings.mcp.formTokenRequired", "token");
  if (/[\r\n\0]/.test(token)) throw new McpFormError("settings.mcp.formInvalidValue", "token");
  if (token) headers.Authorization = /^Bearer\s/i.test(token) ? token : `Bearer ${token}`;
}

export function entryFromDraft(base: McpEntry | undefined, draft: McpDraft, validate = true): McpEntry {
  const initial = base ? draftFromEntry(draft.id, base) : newMcpDraft();
  const local = draft.transport === "stdio";
  if (validate && !draft.name.trim()) throw new McpFormError("settings.mcp.formNameRequired", "name");
  if (local) {
    if (validate && !draft.command.trim()) throw new McpFormError("settings.mcp.formCommandRequired", "command");
    if (draft.command.includes("\0") || draft.args.some(arg => arg.includes("\0"))) {
      throw new McpFormError("settings.mcp.formInvalidValue", "command");
    }
  } else if (validate) {
    try { if (!["http:", "https:"].includes(new URL(draft.url.trim()).protocol)) throw new Error(); }
    catch { throw new McpFormError("settings.mcp.formUrlInvalid", "url"); }
  }

  const entry: McpEntry = { ...base };
  const transportChanged = initial.transport !== draft.transport;
  const patch = (key: string, value: unknown, previous: unknown) => {
    if (!base || JSON.stringify(value) !== JSON.stringify(previous)) entry[key] = value;
  };
  patch("name", draft.name.trim(), initial.name);
  patch("enabled", draft.enabled, initial.enabled);
  patch("autoStart", draft.autoStart, initial.autoStart);
  if (!base || transportChanged) {
    delete entry.type;
    delete entry.source;
    entry.transport = draft.transport;
    if (!base || (initial.transport === "stdio") !== local) {
      const fields = local ? ["url", "headers", "oauth", "oauthEnabled", "xaa"]
        : ["command", "args", "env", "workingDirectory", "inheritParentEnvironment"];
      for (const key of fields) delete entry[key];
    }
  }
  if (local) {
    patch("command", draft.command.trim(), initial.command);
    patch("args", draft.args, initial.args);
    patch("env", rowMap(draft.env, "env"), rowMap(initial.env, "env"));
    if (draft.workingDirectory !== initial.workingDirectory) {
      if (draft.workingDirectory.trim()) entry.workingDirectory = draft.workingDirectory;
      else delete entry.workingDirectory;
    }
  } else {
    patch("url", draft.url.trim(), initial.url);
    const headers = rowMap(draft.headers, "headers");
    applyRemoteAuth(entry, draft, headers, validate);
    patch("headers", headers, rowMap(initial.headers, "headers"));
  }
  if (draft.startupSeconds !== initial.startupSeconds) {
    const timeouts = isMcpEntry(entry.timeouts) ? { ...entry.timeouts } : {};
    if (draft.startupSeconds.trim()) {
      const seconds = Number(draft.startupSeconds);
      const milliseconds = Math.round(seconds * 1000);
      if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0 || milliseconds / 1000 !== seconds) {
        throw new McpFormError("settings.mcp.formTimeoutInvalid", "startupSeconds");
      }
      timeouts.startupMs = milliseconds;
    } else delete timeouts.startupMs;
    if (Object.keys(timeouts).length) entry.timeouts = timeouts;
    else delete entry.timeouts;
  }
  return entry;
}
