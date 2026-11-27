import { invokeCommand, invokeRawCommand, type InvokeCommandOptions } from "./bridge";

export interface McpConfigSnapshot {
  text: string;
  fingerprint: string;
}

export async function readMcpConfig(route: InvokeCommandOptions): Promise<McpConfigSnapshot | null> {
  const reply = await invokeCommand<{ jsonConfig: string; fingerprint: string }>("load_mcp_json_config", undefined, route);
  return typeof reply?.jsonConfig === "string"
    ? { text: reply.jsonConfig, fingerprint: typeof reply.fingerprint === "string" ? reply.fingerprint : "" }
    : null;
}

export function writeMcpConfig(snapshot: McpConfigSnapshot, route: InvokeCommandOptions): Promise<void> {
  return invokeRawCommand("save_mcp_json_config", { jsonConfig: snapshot.text, expectedFingerprint: snapshot.fingerprint }, route);
}

export function mcpConfigSavedWithRuntimeError(message: string): boolean {
  return message.includes("MCP config was saved, but runtime reconciliation failed:");
}
