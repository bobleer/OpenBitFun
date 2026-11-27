import { expect, open, test } from "nsh/test";

const FIXTURE = "./fixtures/selectApp.tsx";
const WINDOW = { width: 580, height: 720, platform: "windows" as const };

test("the shared select uses the listbox and skips disabled options on keyboard selection", async () => {
  const app = await open(FIXTURE, WINDOW);
  const trigger = "id:plain-select";

  await app.press(trigger);
  await app.waitFor("role:listbox");
  await app.waitFor("role:option[Alpha]");
  await app.keyboard.press("end");
  await app.keyboard.press("space");
  await app.waitFor("Saved: gamma");

  await app.press(trigger);
  await app.keyboard.press("home");
  await app.keyboard.press("down");
  await app.keyboard.press("enter");
  await app.waitFor("Saved: beta");

  await app.press(trigger);
  await app.waitFor("role:option[Beta]");
  await app.keyboard.press("end");
  await app.keyboard.press("escape");
  await app.waitFor("role:option[Beta]", { state: "gone" });
  expect(app.shows("Saved: beta")).toBe(true);
});

test("the searchable select submits a match and keeps an empty result list open", async () => {
  const app = await open(FIXTURE, WINDOW);
  const trigger = "id:filtered-select";
  const filter = "label:Filter choices";

  await app.press(trigger);
  await app.type(filter, "ga");
  await app.waitFor("role:option[Gamma]");
  await app.submit(filter);
  await app.waitFor("Saved: gamma");

  await app.press(trigger);
  await app.type(filter, "z");
  await app.submit(filter);
  await app.waitFor("No matching options.");
  expect(app.shows("Saved: gamma")).toBe(true);
  await app.keyboard.press("escape");
  await app.waitFor(filter, { state: "gone" });
});
