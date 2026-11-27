import { expect, open, test } from "nsh/test";
import { createBackend, fleetDeviceRow, fleetObpHost, fleetSessionRow, selectTreeWorkspace } from "./support";

const IMAGE = "iVBORw0KGgoAAAANSUhEUgAAAHgAAAA4CAIAAAC5XqvpAAAAjElEQVR4nO3QUQmAQABAMSMYwyTWEexgFAPZxAgmuD8RfAyWYNN87G/Z1ouRSbToFNGiW0SLbhEtukW06BbRoltEi24RLbpFtOgW0aJbRItuES26RbToFtGiW0T/MPo+F0ZEi24RLbpFtOgW0aJbRItuES26RbToFtGiW0SLbhEtukW06BbRoltEf+QB17Rb7DjAaykAAAAASUVORK5CYII=";
const PNG_NAME = "设计预览.png";
const PNG_PATH = `/repo/${PNG_NAME}`;

test("a phone shares original image bytes locally after reading them from the workspace owner", async () => {
  const backend = createBackend({
    files: [{ name: PNG_NAME, path: PNG_PATH, isDirectory: false }],
    fileContent: { [PNG_PATH]: IMAGE },
  });
  const host = fleetObpHost(backend, {
    fleet: { protocol: 1, cursorState: {}, deviceId: "dev-a" },
    navigator: {
      revision: 1, full: true, removedDeviceIds: [], totals: { running: 0, waiting: 0, unread: 0 },
      devices: [
        fleetDeviceRow("dev-a", "Entry", [], { isClientDevice: true }),
        fleetDeviceRow("dev-b", "Owner", [{
          workspaceId: "ws-b", name: "Remote workspace", rootPath: "/repo", kind: "remote_ssh",
          sessions: [fleetSessionRow("dev-b", "ws-b", "s-b1", "Remote session")],
        }], { hostKind: "desktop", state: "online" }),
      ],
    },
  });
  const files = new Map<string, number[]>();
  const shares: { title: string; path: string; bytes?: number[] }[] = [];
  let action = "dismissed";
  const app = await open("./fixtures/imageShareApp.tsx", {
    platform: "android", width: 390, height: 820, host: { handlers: host.handlers },
    modules: {
      "fs/promises": {
        readdir: () => [],
        mkdir: () => null,
        writeFile: (path: string, data: Record<string, number>) => { files.set(path, Object.values(data)); },
        unlink: (path: string) => { files.delete(path); },
        rmdir: () => null,
      },
      nsh: {
        "Share.available": () => true,
        "Share.show": ({ title, files: paths }: { title: string; files: string[] }) => {
          shares.push({ title, path: paths[0], bytes: files.get(paths[0]) });
          return { action };
        },
      },
    },
  });
  await selectTreeWorkspace(app, "ws-b");
  await app.press(`explorer-row-${PNG_NAME}`);
  await app.press("image-rotate-clockwise");
  await app.press("image-share");
  await app.waitUntil(() => shares.length === 1 && files.size === 0);
  expect(shares[0].title).toBe("Share image");
  expect(shares[0].path.endsWith(`/${PNG_NAME}`)).toBe(true);
  expect(shares[0].bytes).toEqual(Array.from(atob(IMAGE), char => char.charCodeAt(0)));
  expect(host.fleetCalls.find(call => call.command === "read_file_content")).toMatchObject({
    target: "dev-b", args: { request: { workspaceId: "ws-b", filePath: PNG_PATH, encoding: "base64" } },
  });

  action = "shared";
  await app.press("image-fullscreen");
  await app.waitFor("image-lightbox-dialog");
  await app.press("image-lightbox-dialog >> image-share");
  await app.waitUntil(() => shares.length === 2);
  expect(files.get(shares[1].path)).toEqual(shares[0].bytes);
  expect(shares[1].path).not.toBe(shares[0].path);
  expect(host.fleetCalls.filter(call => call.command === "read_file_content")).toHaveLength(1);
});
