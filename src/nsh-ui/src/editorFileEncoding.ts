import { entryDeviceId, fleetActive, fleetDeviceContext, invokeCommand, transportKind } from "./bridge";
import { fleetDeviceById } from "./fleetStore";

export const editorFileEncodings = {
  utf8: "UTF-8",
  "utf8-bom": "UTF-8 with BOM",
  gbk: "GBK",
  gb2312: "GB2312",
  utf16le: "UTF-16LE",
  utf16be: "UTF-16BE",
  iso88591: "ISO-8859-1",
} as const;

export type EditorFileEncoding = keyof typeof editorFileEncodings;

export interface EditorFileByteIdentity {
  encoding: EditorFileEncoding;
  hasBom: boolean;
  sha256: string;
}

export async function readFileWithEncoding(
  workspaceId: string,
  filePath: string,
  encoding: EditorFileEncoding,
): Promise<{ content: string; byteIdentity: EditorFileByteIdentity }> {
  if (fleetActive()) {
    const owner = fleetDeviceContext();
    const localNative = transportKind() === "native" && owner === entryDeviceId();
    if (!localNative && !fleetDeviceById(owner)?.hostCapabilities?.includes("file_text_encoding_v1")) {
      throw new Error("FILE_ENCODING_UNSUPPORTED");
    }
  }
  const reply = await invokeCommand<unknown>("read_file_content", { workspaceId, filePath, textEncoding: encoding });
  const snapshot = reply as Record<string, unknown> | null;
  if (!snapshot || typeof snapshot !== "object" || snapshot.encoding !== encoding ||
      typeof snapshot.content !== "string" || typeof snapshot.hasBom !== "boolean" ||
      typeof snapshot.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.sha256)) {
    // Older runtimes ignore the new request field and send the legacy string.
    throw new Error("FILE_ENCODING_UNSUPPORTED");
  }
  return { content: snapshot.content, byteIdentity: { encoding, hasBom: snapshot.hasBom, sha256: snapshot.sha256 } };
}
