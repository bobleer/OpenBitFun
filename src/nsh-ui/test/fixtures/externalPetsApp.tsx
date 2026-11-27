import "../../src/agentEvents";
import { mount, View } from "nsh";
import { installWindowShell, openHostEventChannel } from "../../src/bridge";
import { createNshDesktopShell } from "../../src/nshDesktopShell";
import { requestSettingsPage, SettingsScene } from "../../src/scenes/SettingsScene";
import { loadWorkspaces } from "../../src/state";
import { palette } from "../../src/theme";

installWindowShell(createNshDesktopShell());
openHostEventChannel();
void loadWorkspaces();
requestSettingsPage("external-import");
mount(() => <View style={{ flex: 1, minHeight: 0, backgroundColor: palette().canvas }}><SettingsScene /></View>);
