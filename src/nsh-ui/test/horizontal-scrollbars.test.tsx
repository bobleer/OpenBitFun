import { expect, open, test } from "nsh/test";

test("wide Markdown and horizontal content keep draggable tracks at the bottom after resize and theme changes", async () => {
  const app = await open("./fixtures/horizontalScrollbars.tsx", {
    width: 760, height: 800, platform: "macos",
  });

  async function checkTracks() {
    for (const id of ["code", "table", "row"]) {
      const container = app.layout(`id:${id}`)!;
      const track = app.layout(`id:${id} >> label:horizontal-track`)!;
      expect(track).not.toBeNull();
      expect(track.width > container.width - 4).toBe(true);
      // Markdown frames include their border and outer margins.
      expect(Math.abs(track.y + track.height - (container.y + container.height)) < 8).toBe(true);
      await app.hover(`id:${id} >> label:horizontal-track`);
      await app.wait(180);
      expect(app.viewStyle(`id:${id} >> label:horizontal-track`)?.effectiveOpacity).toBe(1);
    }
  }

  await checkTracks();
  const before = app.layout("id:row-content")!.x;
  await app.drag("id:row >> label:horizontal-track", { x: 100, y: 0 });
  expect(app.layout("id:row-content")!.x < before).toBe(true);
  await app.setViewport(375, 812);
  await checkTracks();
  await app.press("Light appearance");
  await checkTracks();
});
