// Inside the browser's sandboxed WebView. The page supplies data and the
// bundled renderer as separate elements so it needs no inline JavaScript.
(() => {
  const output = document.getElementById("openbitfun-document-renderer");
  const post = data => window.nsh?.postMessage(data);
  const height = () => Math.ceil(output.getBoundingClientRect().height);

  async function draw() {
    const { kind, source, config } = JSON.parse(output.dataset.diagram);
    if (kind === "math") {
      window.katex.render(source, output, { displayMode: true, throwOnError: true });
    } else {
      window.mermaid.initialize(config);
      const { svg } = await window.mermaid.render("d", source);
      output.innerHTML = svg;
      post(`svg:${height()}:${svg}`);
    }
    post(`h:${height()}`);
  }

  void draw().catch(() => post("error"));
})();
