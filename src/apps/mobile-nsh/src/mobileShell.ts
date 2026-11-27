// The shell of the OpenBitFun phone app (iOS and Android).
//
// The phone is a frontend-only controller: it has no desktop window chrome,
// application menu, tray, folder picker or desktop updater. Installing this
// shell prevents the shared UI from falling back to the legacy page-host shell
// (`createHostPageShell`), which would otherwise send desktop-only commands
// (`quit_app`, `minimize_to_tray`, `miniapp_presentation`) to the remote entry.

import { lstat, mkdir, readdir, rmdir, unlink, writeFile } from "fs/promises";
import { lifecycle, Notifications, platform, Share } from "nsh";
import type { WindowShell } from "../../../nsh-ui/src/windowShell";
import { MAX_REVIEW_PDF } from "../../../nsh-ui/src/pdfReviewData";

const exportDirectory = "${dataDir}/markdown-exports";
const exportLifetimeMs = 24 * 60 * 60 * 1000;
const markdownFileName = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.md$/;
const imageExports = "${dataDir}/image-exports";
const pdfExports = "${dataDir}/pdf-exports";
const maxSharedImageBytes = 8 * 1024 * 1024;

function validExportName(name: string): boolean {
  return Boolean(name.trim()) && name !== "." && name !== ".." && !/[\\/:\0]/.test(name);
}

async function discardExpiredExports(): Promise<void> {
  const expiresBefore = Date.now() - exportLifetimeMs;
  const names = await readdir(exportDirectory).catch(() => []);
  for (const name of names) {
    if (!markdownFileName.test(name)) continue;
    const path = `${exportDirectory}/${name}`;
    const entry = await lstat(path).catch(() => null);
    if (entry?.isFile() && entry.mtimeMs < expiresBefore) await unlink(path).catch(() => undefined);
  }
}

async function discardExpiredBinaryShares(root: string): Promise<void> {
  const expiresBefore = Date.now() - exportLifetimeMs;
  for (const id of await readdir(root).catch(() => [])) {
    if (!/^[a-f0-9-]{36}$/.test(id)) continue;
    const directory = root + "/" + id;
    const entry = await lstat(directory).catch(() => null);
    if (!entry?.isDirectory() || entry.mtimeMs >= expiresBefore) continue;
    const files = await readdir(directory).catch(() => []);
    if (files.length > 1) continue;
    if (files.length === 1 && validExportName(files[0])) {
      const path = `${directory}/${files[0]}`;
      if ((await lstat(path).catch(() => null))?.isFile()) await unlink(path).catch(() => undefined);
    }
    await rmdir(directory).catch(() => undefined);
  }
}

function unsupported(what: string): Promise<never> {
  return Promise.reject(new Error(`${what} is not available on mobile`));
}

export function createMobileShell(): WindowShell {
  let notificationPermissionAsked = false;
  void discardExpiredExports();
  void discardExpiredBinaryShares(imageExports);
  void discardExpiredBinaryShares(pdfExports);

  return {
    id: "mobile",
    nativeDragRegions: false,
    // Updates are distributed by the mobile store, never the remote desktop's updater.
    inAppUpdates: false,
    menuShortcutIds: new Set<string>(),
    async probe(sink) {
      sink.setNative(false);
      sink.setPlatform(platform.os);
      sink.setOverlayTitlebar(false);
      sink.setSystemWindowControls(true);
      sink.setTitleBarInsets(null);
    },
    startDrag() {},
    toggleMaximize() {},
    minimize() {},
    close() {},
    toggleFullscreen() {
      return unsupported("Fullscreen");
    },
    async isFocused() {
      return lifecycle() === "active";
    },
    pickDirectory() {
      return unsupported("Choosing a local folder");
    },
    textFileExport: {
      kind: "share",
      async run({ title, fileName, text }) {
        if (!await Share.available()) return unsupported("Sharing files");
        if (!markdownFileName.test(fileName)) throw new Error("Invalid Markdown export filename");
        await discardExpiredExports();
        await mkdir(exportDirectory, { recursive: true });
        const path = `${exportDirectory}/${fileName.slice(0, -3)}-${crypto.randomUUID().slice(0, 8)}.md`;
        let shared = false;
        try {
          await writeFile(path, text);
          const answer = await Share.show({ title, files: [path] });
          shared = answer.action === "shared";
          return shared ? "shared" : "cancelled";
        } finally {
          // Android reports target selection before the receiving app reads the file.
          if (!shared) await unlink(path).catch(() => undefined);
        }
      },
    },
    binaryFileExport: {
      kind: "share",
      async run({ title, fileName, base64, mimeType }) {
        if (!await Share.available()) return unsupported("Sharing files");
        const pdf = mimeType === "application/pdf" && /\.pdf$/i.test(fileName);
        if ((!pdf && !mimeType.startsWith("image/")) || !validExportName(fileName)) {
          throw new Error(mimeType === "application/pdf" ? "Invalid PDF export" : "Invalid image export");
        }
        const maxBytes = pdf ? MAX_REVIEW_PDF : maxSharedImageBytes;
        const tooLarge = pdf ? "pdf-too-large" : "IMAGE_SHARE_TOO_LARGE";
        if (base64.length > Math.ceil(maxBytes / 3) * 4) throw new Error(tooLarge);
        const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
        if (bytes.length > maxBytes) throw new Error(tooLarge);
        if (bytes.length === 0) throw new Error(pdf ? "PDF data is empty" : "Image data is empty");
        const root = pdf ? pdfExports : imageExports;
        await discardExpiredBinaryShares(root);
        const directory = root + "/" + crypto.randomUUID();
        const path = `${directory}/${fileName}`;
        await mkdir(directory, { recursive: true });
        let shared = false;
        try {
          await writeFile(path, bytes);
          const answer = await Share.show({ title, files: [path] });
          shared = answer.action === "shared";
          return shared ? "shared" : "cancelled";
        } finally {
          if (!shared) {
            await unlink(path).catch(() => undefined);
            await rmdir(directory).catch(() => undefined);
          }
        }
      },
    },
    async appVersion() {
      return null;
    },
    onCloseRequest() {
      return () => undefined;
    },
    hideAfterCloseRequest() {
      return unsupported("Hiding the window");
    },
    minimizeToTray() {
      return unsupported("The tray");
    },
    quit() {
      return unsupported("Quitting the remote backend");
    },
    startIntegration() {
      return () => undefined;
    },
    async setTrayUnreadCount() {},
    async showSystemNotification(title, body) {
      try {
        let permission = await Notifications.permission();
        if (permission === "default" && !notificationPermissionAsked) {
          notificationPermissionAsked = true;
          permission = await Notifications.requestPermission();
        }
        if (permission !== "granted") return;
        await Notifications.show({ id: `openbitfun-${Date.now()}`, title, body });
      } catch {
        // Notification capability denied or unavailable on this device.
      }
    },
  };
}
