import { mount, View } from "nsh";
import "../../src/registerWebRenderers";
import { rendererAssets } from "../../src/documentRenderers";
import { MarkdownPreview } from "../../src/ui/markdownEditor";

const fetchAsset = globalThis.fetch;
const mermaidScript = rendererAssets()?.mermaidScript;
globalThis.fetch = async (input, init) => {
  if (input === mermaidScript) {
    await new Promise<void>(resolve => setTimeout(resolve, 8_250));
  }
  return fetchAsset(input, init);
};

mount(() => (
  <View style={{ flex: 1 }}>
    <MarkdownPreview markdown={"```mermaid\nflowchart LR\n  Draft --> Review\n```"} />
  </View>
));
