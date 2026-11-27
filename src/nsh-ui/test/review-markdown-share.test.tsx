import { expect, open, test } from "nsh/test";

test("phone shares a local Markdown file and keeps the saved review after sharing an edited copy", async () => {
  const files = new Map<string, string>();
  const shared: { title: string; path: string; text?: string }[] = [];
  let action = "dismissed";
  // The headless host has no native ${dataDir}. Keep its file and share calls
  // together so a shared path must resolve to the bytes written by the phone.
  const app = await open("./fixtures/reviewShareApp.tsx", {
    platform: "android",
    modules: {
      "fs/promises": {
        readdir: () => [],
        mkdir: () => null,
        writeFile: (path: string, text: string) => { files.set(path, text); },
        unlink: (path: string) => { files.delete(path); },
      },
      nsh: {
        "Share.available": () => true,
        "Share.show": (payload: { title: string; files: string[] }) => {
          const [path] = payload.files;
          shared.push({ title: payload.title, path, text: files.get(path) });
          return { action };
        },
      },
    },
  });
  await app.press("label:review-share-markdown");
  await app.waitUntil(() => shared.length === 1 && files.size === 0);
  expect(shared[0].path).toMatch(/^\$\{dataDir\}\/markdown-exports\/review-.*\.md$/);
  expect(shared[0].text).toContain("Saved review evidence");

  action = "shared";
  await app.press("label:review-open-markdown");
  await app.press("label:review-editor-source");
  await app.clear("label:review-editor-text");
  await app.type("label:review-editor-text", "# Edited review");
  await app.press("label:review-editor-share");
  await app.waitUntil(() => shared.length === 2);
  expect(shared[1].title).toBe("Share Markdown");
  expect(shared[1].path).not.toBe(shared[0].path);
  expect(shared[1].text).toBe("# Edited review");

  await app.press("label:review-editor-close");
  await app.waitFor("Discard changes");
  await app.press("Confirm");
  await app.waitUntil(() => !app.shows("label:review-markdown-editor"));
  expect(files.size).toBe(1);
  expect(files.get(shared[1].path)).toBe("# Edited review");
  expect(app.texts()).toContain("Saved review evidence");
});
