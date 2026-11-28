import { mount, signal, Text } from "nsh";
import { setRendererAssets } from "../../src/documentRenderers";
import { materializeFigureAtlas } from "../../src/ui/figureAtlas";

setRendererAssets({
  mermaidScript: "", katexScript: "", katexStyle: "",
  figureAtlas: { stylesheet: "https://raw.githubusercontent.com/figure-test/map.css", notices: "" },
});

const status = signal("loading");
const figure = '<script type="application/json" data-visual-atlas="1">' +
  '{"places":[{"name":"Private label","coordinates":[120,30]}]}</script>';
void materializeFigureAtlas(figure).then(result => {
  status.set(result?.html.includes('data-map-layer="land"') ? "map rendered" : "map unavailable");
});

mount(() => <Text>{status()}</Text>);
