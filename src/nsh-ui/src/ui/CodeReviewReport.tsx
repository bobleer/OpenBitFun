import { Text, View, type JSX } from "nsh";
import {
  reviewFindingLocation, reviewFindingMetadata, reviewFindingsTitle, reviewGroupLabels,
  reviewRecommendationLabel, reviewSeverityLabel, type CodeReviewReport as Report,
} from "../codeReviewReport";
import { tr } from "../i18n";
import { fontMono, palette, space, textStyle } from "../theme";
import { InlineBanner } from "./primitives";
import { ReviewMarkdownActions } from "./ReviewMarkdownActions";

const evidenceNotices = {
  limited: { tone: "warning", label: "chat.review.evidenceLimited" },
  failed: { tone: "danger", label: "chat.review.evidenceFailed" },
} as const;

function ReportText(props: { children: JSX.Element }) {
  return <Text style={{ ...textStyle("body"), color: palette().textSecondary, userSelect: "text" }}>
    {props.children}
  </Text>;
}

function ReportSection(props: { title: string; children: JSX.Element }) {
  return <View style={{ gap: space.sm, paddingTop: space.md, borderTopWidth: 1, borderColor: palette().borderSubtle }}>
    <Text style={textStyle("sectionTitle")}>{props.title}</Text>
    {props.children}
  </View>;
}

function ReportList(props: { items: string[] }) {
  return <Each of={props.items} key={item => item}>
    {item => <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
      <Text style={{ ...textStyle("body"), color: palette().textMuted }}>•</Text>
      <View style={{ flex: 1, minWidth: 0 }}><ReportText>{item()}</ReportText></View>
    </View>}
  </Each>;
}

function ReportGroups(props: { groups: Array<{ key: keyof typeof reviewGroupLabels; items: string[] }> }) {
  return <Each of={props.groups} key={group => group.key}>
    {group => <View style={{ gap: space.xs }}>
      <Text style={textStyle("label")}>{tr(reviewGroupLabels[group().key])}</Text>
      <ReportList items={group().items} />
    </View>}
  </Each>;
}

function ReportFinding(props: { issue: Report["findings"][number] }) {
  const issue = () => props.issue;
  const location = () => reviewFindingLocation(issue());
  const metadata = () => reviewFindingMetadata(issue());

  return <View style={{ gap: space.xs, paddingLeft: space.md, borderLeftWidth: 1, borderColor: palette().borderStrong }}>
    <If when={metadata()}>
      {label => <Text style={{ ...textStyle("caption"), color: palette().textSecondary }}>{label()}</Text>}
    </If>
    <If when={issue().title}>
      {title => <Text style={{ ...textStyle("label"), userSelect: "text" }}>{title()}</Text>}
    </If>
    <If when={location()}>
      {label => <Text style={{ ...textStyle("caption"), color: palette().textSecondary, fontFamily: fontMono(), userSelect: "text" }}>
        {label()}
      </Text>}
    </If>
    <If when={issue().description}><ReportText>{issue().description}</ReportText></If>
    <If when={issue().suggestion}><ReportText>{tr("chat.review.suggestion", { text: issue().suggestion })}</ReportText></If>
    <If when={issue().validationNote}><ReportText>{issue().validationNote}</ReportText></If>
  </View>;
}

export function CodeReviewReport(props: { report: Report; actions?: JSX.Element }) {
  const report = () => props.report;
  const evidenceNotice = () => {
    const evidence = report().evidence;
    return evidence === "limited" || evidence === "failed" ? evidenceNotices[evidence] : null;
  };

  return <View testID="code-review-report" style={{ gap: space.md, minWidth: 0 }}>
    <View style={{ gap: space.xs }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Text style={{ ...textStyle("sectionTitle"), flex: 1, minWidth: 0 }}>
          {tr(report().deep ? "chat.review.deepAssessment" : "chat.review.assessment")}
        </Text>
        <ReviewMarkdownActions report={report()} />
      </View>
      <If when={report().assessment}><ReportText>{report().assessment}</ReportText></If>
      <If when={report().risk}>
        {risk => <ReportText>{tr("chat.review.risk", { level: reviewSeverityLabel(risk()) })}</ReportText>}
      </If>
      <If when={report().action}>
        {action => <ReportText>{tr("chat.review.recommendation", { action: reviewRecommendationLabel(action()) })}</ReportText>}
      </If>
      <ReportList items={report().executiveSummary} />
    </View>
    <If when={evidenceNotice()}>
      {notice => <InlineBanner tone={notice().tone} message={tr(notice().label)} />}
    </If>
    <If when={report().targetChangedDuringReview}>
      <InlineBanner tone="warning" message={tr("chat.review.evidenceStale")} />
    </If>
    <ReportSection title={reviewFindingsTitle(report())}>
      <If when={!report().findingsComplete}>
        <ReportText>{tr("chat.review.findingsUnavailable")}</ReportText>
      </If>
      <Each of={report().findings}>{issue => <ReportFinding issue={issue()} />}</Each>
    </ReportSection>
    <If when={report().remediation.length || report().legacyRemediation.length}>
      <ReportSection title={tr("chat.review.remediation")}>
        <ReportGroups groups={report().remediation} />
        <ReportList items={report().legacyRemediation} />
      </ReportSection>
    </If>
    <If when={report().strengths.length || report().legacyStrengths.length}>
      <ReportSection title={tr("chat.review.strengths")}>
        <ReportGroups groups={report().strengths} />
        <ReportList items={report().legacyStrengths} />
      </ReportSection>
    </If>
    <If when={report().scope || report().confidence || report().coverageNotes.length}>
      <ReportSection title={tr("chat.review.coverage")}>
        <If when={report().scope}><ReportText>{report().scope}</ReportText></If>
        <If when={report().confidence}><ReportText>{report().confidence}</ReportText></If>
        <ReportList items={report().coverageNotes} />
      </ReportSection>
    </If>
    {props.actions}
  </View>;
}
