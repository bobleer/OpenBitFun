// Shared Remote Connect disclaimer state, persisted under the desktop's storage
// key so agreeing once covers account sign-in and chat-app connectors alike.
// Account sign-in (`openAccountAuthModal`, `requestEmailCode`, `startGitHubSignIn`,
// `requestControllerCode`) and first-time chat-app bot connections gate on
// `ensureRemoteDisclaimer`, refusing to proceed until the user agrees.

import { Storage, signal } from "nsh";

/** The desktop's key, so agreeing on either surface counts for both. */
export const REMOTE_CONNECT_DISCLAIMER_KEY = "openbitfun:remote-connect:disclaimer-agreed:v1";
export const remoteDisclaimerAgreed = signal(false);
export const remoteDisclaimerOpen = signal(false);

let disclaimerLoaded: Promise<void> | null = null;
let pendingAfterDisclaimer: (() => void | Promise<void>) | null = null;

export function loadRemoteDisclaimer(): Promise<void> {
  if (!disclaimerLoaded) {
    disclaimerLoaded = Storage.getItem(REMOTE_CONNECT_DISCLAIMER_KEY)
      .then(value => {
        if (value === "true") remoteDisclaimerAgreed.set(true);
      })
      .catch(() => undefined);
  }
  return disclaimerLoaded;
}

/**
 * Shows the Remote Connect disclaimer before account sign-in or the first
 * remote connector setup, and runs nothing until it is agreed. Returns whether
 * `action` may run immediately; otherwise `action` runs after the user agrees.
 */
export async function ensureRemoteDisclaimer(action: () => void | Promise<void>): Promise<boolean> {
  await loadRemoteDisclaimer();
  if (remoteDisclaimerAgreed()) return true;
  pendingAfterDisclaimer = action;
  remoteDisclaimerOpen.set(true);
  return false;
}

export function openRemoteDisclaimer(): void {
  void loadRemoteDisclaimer();
  pendingAfterDisclaimer = null;
  remoteDisclaimerOpen.set(true);
}

export function declineRemoteDisclaimer(): void {
  pendingAfterDisclaimer = null;
  remoteDisclaimerOpen.set(false);
}

export async function agreeRemoteDisclaimer(): Promise<void> {
  remoteDisclaimerAgreed.set(true);
  remoteDisclaimerOpen.set(false);
  try {
    await Storage.setItem(REMOTE_CONNECT_DISCLAIMER_KEY, "true");
  } catch {
    // Storage failures fall back to the in-memory agreement for this run.
  }
  const action = pendingAfterDisclaimer;
  pendingAfterDisclaimer = null;
  if (action) await action();
}
