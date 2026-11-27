// Trusted reader used by the browser's dedicated worker and the native
// controller's short-lived WebView. Figure HTML never runs in either.
(() => {
  const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);
  const maxBytes = 256 * 1024;

  async function readImage(link) {
    const url = new URL(link);
    if (url.protocol !== "https:" || url.username || url.password || url.port || /[#\\\s]/.test(link)) {
      throw new Error("Invalid figure image URL");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(url, {
        credentials: "omit", referrerPolicy: "no-referrer", mode: "cors", redirect: "error",
        signal: controller.signal,
      });
      const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (!response.ok || !imageTypes.has(type) || !response.body ||
          Number(response.headers.get("content-length")) > maxBytes) throw new Error("Invalid figure image");
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error("Figure image exceeds 256 KiB");
        chunks.push(value);
      }
      if (!size) throw new Error("Empty figure image");
      return await new Promise((resolve, reject) => {
        const file = new FileReader();
        file.onload = () => resolve(String(file.result));
        file.onerror = reject;
        file.readAsDataURL(new Blob(chunks, { type }));
      });
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async function load(nonce, url, send) {
    try { send({ nonce, url, value: await readImage(url) }); }
    catch { send({ nonce, url }); }
  }

  if (typeof document === "undefined") {
    self.addEventListener("message", event => {
      const { nonce, url } = event.data;
      void load(nonce, url, message => self.postMessage(message));
    }, { once: true });
  } else {
    const { nonce, urls } = JSON.parse(document.getElementById("figure-image-request").textContent);
    for (const url of urls) {
      void load(nonce, url, message => window.nsh?.postMessage(JSON.stringify(message)));
    }
  }
})();
