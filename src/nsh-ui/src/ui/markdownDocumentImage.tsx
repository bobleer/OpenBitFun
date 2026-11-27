import { cleanup, effect, Image, signal, Text } from "nsh";
import type { TextViewImage } from "nsh/base";
import { invokeCommand } from "../bridge";
import { extensionOf } from "../format";
import { tr } from "../i18n";
import { basenameOfPath } from "../shared/workspaceUtils";
import { palette, radii, textStyle } from "../theme";
import { resolveMarkdownMediaTarget } from "./markdownMedia";

export interface MarkdownImageWorkspace {
  deviceId: string;
  workspaceId: string;
  workspacePath?: string;
  remote: boolean;
}

const pendingImages = new Map<string, Promise<string | null>>();

interface RenderedImage { source: string; width: number; height: number }

function readWorkspaceImage(workspace: MarkdownImageWorkspace, path: string): Promise<string | null> {
  const key = JSON.stringify([workspace.deviceId, workspace.workspaceId, workspace.workspacePath, path]);
  const pending = pendingImages.get(key);
  if (pending) return pending;
  const ext = extensionOf(path);
  const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext || "png"}`;
  const request = invokeCommand<string>("read_file_content", {
    workspaceId: workspace.workspaceId,
    workspacePath: workspace.workspacePath,
    filePath: path,
    encoding: "base64",
  }, { target: workspace.deviceId || undefined })
    .then(encoded => encoded ? `data:${mime};base64,${encoded}` : null)
    .finally(() => pendingImages.delete(key));
  pendingImages.set(key, request);
  return request;
}

/** The decoded image belongs only to this view. The editor keeps the Markdown's original source. */
export function MarkdownDocumentImage(props: {
  image: TextViewImage;
  documentPath: string;
  workspace?: MarkdownImageWorkspace;
  maxWidth: number;
  workspaceRoot?: string;
}) {
  const rendered = signal<RenderedImage | null | undefined>(undefined);
  const reference = () => props.image.src.trim();
  const label = () => {
    const source = reference();
    const name = /^data:/i.test(source) ? "" : basenameOfPath(source.split(/[?#]/)[0], props.workspace?.remote);
    return props.image.alt || props.image.title || name || tr("doc.image");
  };

  effect(() => {
    const source = reference();
    const workspace = props.workspace;
    rendered.set(undefined);
    let mounted = true;
    cleanup(() => { mounted = false; });
    const imageUrl = async () => {
      if (/^(https?:|data:image\/|asset:\/)/i.test(source)) return source;
      if (!workspace?.workspaceId || !props.documentPath) return null;
      const target = resolveMarkdownMediaTarget(source, {
        documentPath: props.documentPath,
        workspaceRoot: props.workspaceRoot,
        isRemote: workspace.remote,
      });
      if (target.kind !== "workspace") return null;
      for (const path of target.paths) {
        const url = await readWorkspaceImage(workspace, path).catch(() => null);
        if (url) return url;
      }
      return null;
    };
    void imageUrl().then(async url => {
      if (!mounted || !url) return null;
      const size = await Image.getSize(url);
      return size.width > 0 && size.height > 0 ? { source: url, width: size.width, height: size.height } : null;
    }).catch(() => null).then(value => {
      if (mounted) rendered.set(value);
    });
  });

  function imageWidth(image: RenderedImage) {
    const requested = props.image.width;
    if (typeof requested === "string") return requested;
    const height = props.image.height;
    const natural = typeof height === "number" ? height * image.width / image.height : image.width;
    return Math.min(requested ?? natural, props.maxWidth || Infinity);
  }

  return <If when={rendered()} else={<Text style={textStyle("caption", { color: palette().textMuted })}>
    {rendered() === null ? tr("files.imageUnavailable", { name: label() }) : label()}
  </Text>}>
    {image => <Image src={image().source} role="image" accessibilityLabel={label()}
      style={{ width: imageWidth(image()), height: props.image.height ?? (typeof imageWidth(image()) === "number"
        ? Number(imageWidth(image())) * image().height / image().width : undefined),
        aspectRatio: image().width / image().height, maxWidth: props.maxWidth || "100%", objectFit: "contain", borderRadius: radii.sm }} />}
  </If>;
}
