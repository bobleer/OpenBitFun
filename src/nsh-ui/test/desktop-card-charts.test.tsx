import { expect, open, test } from "nsh/test";
import { cardLineGeometry, desktopCardChart } from "../src/desktopCardChart";

test("a desktop card renders the five shapes and updates its line from new data", async () => {
  const app = await open("./fixtures/cardChartsApp.tsx", { width: 350, height: 680, locale: "en-US" });
  await app.waitFor("id:desktop-card-chart-line");
  await app.waitFor("text:+8 since Monday");
  await app.waitFor("text:-10 – 25");
  await app.waitFor("text:Last three days");
  await app.press("Update samples");
  await app.waitFor("text:+17 since Monday");

  await app.press("donut");
  await app.waitFor("id:desktop-card-chart-ring");
  await app.waitFor("text:64%");
  await app.waitFor("text:Unused");
  expect(app.shows("id:desktop-card-chart-line")).toBe(false);

  await app.press("stacked");
  await app.waitFor("id:desktop-card-chart-stack");
  await app.waitFor("text:of 50 · 64%");
  await app.waitFor("text:36%");

  await app.press("column");
  await app.waitFor("id:desktop-card-chart-columns");
  expect(app.shows("text:Unused")).toBe(false);

  await app.press("bar");
  await app.waitFor("text:70%");
  expect(app.shows("id:desktop-card-chart-columns")).toBe(false);
});

test("saved charts keep their data source precedence, series limits and positive domains", () => {
  const quantities = Array.from({ length: 125 }, (_, i) => i - 10);
  const line = desktopCardChart({ chart: "line", itemsPath: "", total: 500 }, quantities, "Other");
  expect(line?.points.length).toBe(120);
  expect(line?.points[0]).toEqual({ label: "6", value: -5 });
  expect(line?.total).toBe(null);
  const geometry = cardLineGeometry(line!.points);
  expect(geometry?.coordinates[0]).toEqual({ x: 0, y: 0.95 });
  expect(Math.round((geometry?.coordinates.at(-1)?.y ?? 0) * 100)).toBe(5);

  const series = { itemsPath: "/rows", labelKey: "day", valueKey: "count", hintKey: "detail", totalPath: "/scale" };
  const data = {
    rows: [{ day: "Mon", count: "-4", detail: "Unavailable", tone: "warning" },
      ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6], ["Sun", 7], ["Invalid", "-"]],
    scale: 40,
  };
  const donut = desktopCardChart({ ...series, chart: "donut" }, data, "Other");
  expect(donut?.points[0]).toEqual({ label: "Mon", value: 0, hint: "Unavailable", tone: "warning" });
  expect(donut?.points.at(-1)).toEqual({ label: "Other", value: 13 });
  expect([donut?.sum, donut?.remainder, donut?.scale]).toEqual([27, 13, 40]);

  const column = desktopCardChart({ chart: "column", itemsPath: "" }, quantities, "Other");
  expect([column?.points.length, column?.points.at(-1)?.label]).toEqual([24, "24"]);
  expect(desktopCardChart({ chart: "bar", itemsPath: "/missing", items: [{ label: "Old", value: 7 }] }, {}, "Other")?.points).toEqual([]);
  expect(desktopCardChart({ chart: "future-chart" }, {}, "Other")).toBe(null);
});
