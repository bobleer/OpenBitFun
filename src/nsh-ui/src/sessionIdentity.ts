import { computed, signal } from "nsh";

export const activeSessionId = signal<string | null>(null);
/** Empty on a connection without the fleet layer. */
export const activeSessionDevice = signal("");
export const secondarySessionId = signal<string | null>(null);
export const secondarySessionDevice = signal("");
export const splitPaneOpen = signal(false);

export const activeSessionKey = computed<string | null>(() => {
  const id = activeSessionId();
  return id ? `${activeSessionDevice()}/${id}` : null;
});

export const secondarySessionKey = computed<string | null>(() => {
  const id = secondarySessionId();
  return splitPaneOpen() && id ? `${secondarySessionDevice()}/${id}` : null;
});
