import { expect, open, test } from "nsh/test";
import { createBackend } from "./support";

test("search shortcuts navigate from the focused input without opening the first action", async () => {
  const app = await open("./fixtures/searchApp.tsx", { width: 900, height: 580 });
  await app.press("Open search palette");
  await app.waitFor("id:global-search-item-command:files");
  expect(app.enabled("id:global-search-scope-content")).toBe(false);
  await app.keyboard.press("end");
  await app.keyboard.press("up");
  await app.keyboard.press("down");
  await app.keyboard.press("enter");
  await app.waitFor("Selected files");
  await app.waitFor("global-search-dialog", { state: "gone" });
});

test("the query can be cleared while a previous content search is still outstanding", async () => {
  const app = await open("./fixtures/searchApp.tsx", { width: 900, height: 580 });
  await app.press("Open content search");
  await app.press("id:global-search-scope-content");
  await app.type("global-search-input", "old query");
  await app.waitFor("Search request pending");
  await app.press("global-search-clear");
  await app.waitFor("Enter at least two characters to search content.");
  await app.waitFor("Search request settled");
  expect(app.shows("Late result")).toBe(false);
});

test("documented capabilities reveal destinations in the global search Actions scope", async () => {
  const backend = createBackend();
  const app = await open("../App.tsx", { width: 1200, height: 800, host: { handlers: backend.handlers } });

  await app.press("global-search-trigger");
  await app.type("global-search-input", ">agent lifecycle hooks globally");
  const hooks = "id:global-search-item-capability:setting.tools.automation";
  await app.waitFor(hooks);
  await app.waitFor("text:Enable or disable agent lifecycle hooks globally (user-level hooks on by default)");
  expect(backend.calls.some(call => call.action === "search_session_content")).toBe(false);
  await app.press(hooks);
  await app.waitFor("text:Run native agent hooks");
  await app.waitFor("global-search-dialog", { state: "gone" });

  await app.press("global-search-trigger");
  await app.type("global-search-input", "Pages Publishing");
  expect(app.shows("id:global-search-item-capability:feature.pages")).toBe(false);
  await app.clear("global-search-input");
  await app.type("global-search-input", ">Skill Market");
  const skills = "id:global-search-item-capability:feature.skills";
  await app.waitFor(skills);
  await app.press(skills);
  await app.waitFor("library-tab-skills");
  await app.waitFor("text:Installed");
  expect(backend.settingsWrites).toHaveLength(0);
});

test("search omits retired voice controls and still opens supported input settings", async () => {
  const backend = createBackend();
  const app = await open("./fixtures/windowsCaptionApp.tsx", {
    platform: "windows", width: 1440, height: 900, host: { handlers: backend.handlers },
  });
  await app.press("global-search-trigger");
  for (const query of ["voice input", "realtime voice call", "microphone"]) {
    await app.clear("global-search-input");
    await app.type("global-search-input", `>${query}`);
    expect(app.shows("id:global-search-item-capability:feature.voice-input")).toBe(false);
    expect(app.shows("id:global-search-item-capability:setting.application.input")).toBe(false);
    expect(app.shows("id:global-search-item-capability:setting.application.pet")).toBe(false);
  }

  await app.clear("global-search-input");
  await app.type("global-search-input", ">messages sent during an active turn");
  const input = "id:global-search-item-capability:setting.application.input";
  await app.waitFor(input);
  await app.press(input);
  await app.waitFor("nav-settings-page-input");
  await app.waitFor("global-search-dialog", { state: "gone" });
});
