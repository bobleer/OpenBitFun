// NativeUI cards on the native desktop: the runner embeds each card in an NSH
// engine of its own (`native/src/runner/genui_card.rs`, the native component
// `openbitfun.genui-card`). Where the runner has no nested engine view
// (Windows, Linux for now) `Backend.nativeCards()` is false and the shared UI
// shows the card's source with an explicit notice instead.

import { nativeComponent } from "nsh";
import { Backend } from "openbitfun/native";
import { installNativeCardHost, type NativeCardProps } from "../../../nsh-ui/src/nativeui/nativeCardHost";

interface CardEvents {
  ask: { text?: string };
  copy: { text?: string };
  state: { key?: string; value?: unknown };
  openUrl: { url?: string };
  error: { message?: string };
}

const GenuiCard = nativeComponent<Pick<NativeCardProps, "factory" | "theme" | "state">, CardEvents>(
  "openbitfun.genui-card",
  {
    props: ["factory", "theme", "state"],
    events: ["ask", "copy", "state", "openUrl", "error"],
  },
);

void Backend.nativeCards().then(
  available => {
    if (available) installNativeCardHost({ Card: props => <GenuiCard {...props} /> });
  },
  () => undefined,
);
