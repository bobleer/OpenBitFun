import { Text, View } from "nsh";
import { dismissExternalSlashDialog, externalSlashDialog } from "../externalSlashCommands";
import { tr } from "../i18n";
import { palette, space, textStyle } from "../theme";
import { ModalDialog } from "./overlays";
import { Button, ConfigRow, ConfigSection, InlineBanner } from "./primitives";

export function ExternalSlashDialogs() {
  const choice = () => {
    const dialog = externalSlashDialog();
    return dialog?.kind === "choice" ? dialog : null;
  };
  const shell = () => {
    const dialog = externalSlashDialog();
    return dialog?.kind === "shell" ? dialog : null;
  };
  const cancel = () => <Button label={tr("common.cancel")} variant="secondary" onPress={dismissExternalSlashDialog} />;

  return <>
    <If when={choice()}>{dialog => (
      <ModalDialog open size="md" title={tr("chat.externalSlash.chooseSource", { command: `/${dialog().name}` })}
        accessibilityLabel="external-slash-choice" onClose={dismissExternalSlashDialog} footer={cancel()}>
        <ConfigSection title="" flush>
          <Each of={dialog().options} key={option => option.id}>
            {(option, index) => (
              <ConfigRow label={option().label} description={option().description} wrap topDivider={index() > 0} divider={false}>
                <Button label={tr("chat.externalSlash.choose")} size="sm" variant="secondary"
                  accessibilityLabel={`external-slash-choose-${option().id}`} disabled={option().disabled}
                  onPress={() => option().pick()} />
              </ConfigRow>
            )}
          </Each>
        </ConfigSection>
      </ModalDialog>
    )}</If>
    <If when={shell()}>{dialog => (
      <ModalDialog open size="lg" title={tr("chat.externalSlash.reviewTitle")} subtitle={dialog().review.sourceDisplayName}
        accessibilityLabel="external-slash-shell-review" onClose={dismissExternalSlashDialog}
        footer={<>
          {cancel()}
          <If when={dialog().review.canRemember}>
            <Button label={tr("chat.externalSlash.remember")} variant="secondary"
              accessibilityLabel="external-slash-remember" onPress={() => dialog().approve("remember")} />
          </If>
          <Button label={tr("chat.externalSlash.runOnce")} variant="primary"
            accessibilityLabel="external-slash-run-once" onPress={() => dialog().approve("run_once")} />
        </>}>
        <View style={{ gap: space.md }}>
          <InlineBanner tone="warning" message={tr("chat.externalSlash.reviewWarning")} />
          <ConfigSection title="" flush>
            <ConfigRow label={tr("chat.externalSlash.workingDirectory")} description={dialog().review.workingDirectory}
              wrap divider={false} />
            <ConfigRow label={dialog().review.shellDisplayName} description={dialog().review.shellExecutable}
              wrap topDivider divider={false} />
          </ConfigSection>
          <ConfigSection title={tr("chat.slash.title")} flush>
            <Text style={{ ...textStyle("body"), color: palette().text }}>{dialog().review.commands.join("\n\n")}</Text>
          </ConfigSection>
        </View>
      </ModalDialog>
    )}</If>
  </>;
}
