import { computed, Text, View, type TextProps } from "nsh";
import { codeSnippetLocation, type CodeSnippetContext } from "../codeSnippetReference";
import type { MermaidContext } from "../mermaidReference";
import { tr } from "../i18n";
import { promptReferenceParts, type PromptReference } from "../promptReferences";
import type { PullRequestContext } from "../pullRequestReference";
import { palette, radii, space, textStyle } from "../theme";
import { Icon } from "./icons";
import { TooltipBubble } from "./primitives";

export function PromptReferenceCapsule(props: {
  reference: Pick<PromptReference, "kind" | "label"> & { context?: CodeSnippetContext | MermaidContext | PullRequestContext };
  labelPrefix: string;
  selected?: boolean;
}) {
  const label = () => props.reference.context?.type === "mermaid-diagram" && !props.reference.context.diagramTitle
    ? tr("doc.mermaidDiagram") : props.reference.label;
  const tooltip = () => {
    const context = props.reference.context;
    if (context?.type === "code-snippet") return codeSnippetLocation(context);
    if (context?.type === "pull-request") return context.pullRequestTitle ?? label();
    return context?.diagramTitle ?? label();
  };
  return (
    <View
      accessibilityLabel={`${props.labelPrefix}-${props.reference.kind}-${props.reference.label}`}
      tooltip={<TooltipBubble text={tooltip()} />}
      style={{
        flexDirection: "row", alignItems: "center", gap: space.xs,
        maxWidth: 224, paddingHorizontal: space.chip, marginHorizontal: space.hair,
        borderWidth: 1, borderRadius: radii.sm,
        borderColor: props.selected ? palette().accent : palette().borderSubtle,
        backgroundColor: palette().panelHover, userSelect: "none",
      }}
    >
      <Icon name={props.reference.kind === "pull-request" ? "git-pull-request" : props.reference.kind === "mcp" ? "plug" : props.reference.kind === "skill" ? "sparkles" : "code"}
        size={12} color={palette().textSecondary} />
      <Text style={{
        ...textStyle("caption", { color: palette().textSecondary }), minWidth: 0, flexShrink: 1,
        fontWeight: "500", numberOfLines: 1, textOverflow: "ellipsis",
      }}>
        {label()}
      </Text>
    </View>
  );
}

/** Keep the surrounding prose in one native paragraph while drawing prompt objects inline. */
export function PromptReferenceText(props: { text: string; labelPrefix: string; style?: TextProps["style"] }) {
  const parts = computed(() => promptReferenceParts(props.text));
  return (
    <Text style={props.style}>
      <Each of={parts()} key={part => `${part.kind}:${part.start}`}>
        {part => {
          const reference = () => {
            const value = part();
            return value.kind === "text" ? null : value;
          };
          const text = () => {
            const value = part();
            return value.kind === "text" ? value.text : "";
          };
          return <If when={reference()} else={text()}>
            {item => <PromptReferenceCapsule reference={item()} labelPrefix={props.labelPrefix} />}
          </If>;
        }}
      </Each>
    </Text>
  );
}
