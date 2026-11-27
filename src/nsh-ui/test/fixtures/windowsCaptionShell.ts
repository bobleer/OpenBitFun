import { installWindowShell } from "../../src/bridge";
import { createNshDesktopShell } from "../../src/nshDesktopShell";

installWindowShell({
  ...createNshDesktopShell(),
  async probe(sink) {
    sink.setNative(true);
    sink.setPlatform("windows");
    sink.setTitleBarInsets({ left: 0, right: 160 });
    sink.setSystemWindowControls(true);
  },
});
