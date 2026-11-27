import { computed, effect, Scroll, signal, Text, View } from "nsh";
import { formatCount } from "../format";
import { tr } from "../i18n";
import { reviewOutcomeDescription, reviewRunSummary } from "../reviewPresentation";
import { gitRangeReviewLabel, openReviewChild, type ReviewTarget } from "../reviewStore";
import { useSessionReviewRecords, type SessionReviewRecord } from "../sessionReviewRecords";
import { space, textStyle } from "../theme";
import { ActionCard } from "./ActionCard";
import { Button, InlineBanner } from "./primitives";

function reviewTargetLabel(record: SessionReviewRecord): string {
  switch (record.target.kind) {
    case "pull_request":
      return tr("review.recordPullRequest", { number: formatCount(record.target.number), project: record.target.projectPath });
    case "git_range": {
      const { baseRevision, headRevision } = record.target;
      return baseRevision && headRevision ? gitRangeReviewLabel({ baseRevision, headRevision }) : tr("review.recordGitRange");
    }
    case "workspace": return tr("review.recordWorkspace");
  }
}

export function SessionReviewRecords(props: {
  target: () => ReviewTarget | null;
  padding: () => number;
  width: () => number;
}) {
  const records = useSessionReviewRecords(props.target);
  const expanded = signal(false);
  effect(() => { records.key(); expanded.set(false); });
  const visible = computed(() => {
    const rows = records.page()?.records ?? [];
    return expanded() ? rows : rows.slice(0, 1);
  });

  function openRecord(record: SessionReviewRecord): void {
    const target = props.target();
    if (target) openReviewChild({ childSessionId: record.sessionId, childSessionName: record.sessionName,
      agentType: record.agentType }, record.agentType === "DeepReview" ? "strict" : "review", target);
  }

  return <If when={visible().length || records.error() || records.hasNewer()}>
    <View testID="session-review-records" style={{ paddingHorizontal: props.padding(), paddingTop: space.sm }}>
      <View style={{ width: "100%", maxWidth: props.width(), alignSelf: "center", gap: space.xs }}>
        <If when={records.error()}>
          <InlineBanner tone="warning" message={tr("review.recordsLoadFailed")}
            actionLabel={tr("common.retry")} onAction={records.reload} />
        </If>
        <Scroll style={{ maxHeight: expanded() ? 260 : undefined, minHeight: 0, flexShrink: 1 }}>
          <View style={{ gap: space.xs }}>
            <Each of={visible()} key={record => record.sessionId}>
              {record => <ActionCard icon="history" label={reviewTargetLabel(record())} compact multilineDetail
                detail={reviewRunSummary(record(), record().target.kind === "pull_request")}
                description={reviewOutcomeDescription(record())} testID={`session-review-record-${record().sessionId}`}
                onPress={() => openRecord(record())} />}
            </Each>
          </View>
        </Scroll>
        <If when={(records.page()?.records.length ?? 0) > 1 || records.page()?.nextCursor || records.hasNewer()}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xs }}>
            <Button size="sm" variant="ghost" label={tr(expanded() ? "review.recordsCollapse" : "review.recordsExpand")}
              accessibilityLabel="session-review-records-expand" onPress={() => {
                if (expanded() && records.hasNewer()) records.latest();
                expanded.set(!expanded());
              }} />
            <If when={expanded() && records.hasNewer()}>
              <Button size="sm" variant="ghost" label={tr("pullRequests.history.newer")}
                accessibilityLabel="session-review-records-newer" disabled={records.loading()} onPress={records.newer} />
            </If>
            <If when={expanded() && records.page()?.nextCursor}>
              <Button size="sm" variant="ghost" label={tr("pullRequests.history.older")}
                accessibilityLabel="session-review-records-older" disabled={records.loading()} onPress={records.older} />
            </If>
          </View>
        </If>
        <If when={visible().some(record => record.recordHistoryComplete === false)}>
          <Text style={textStyle("caption")}>{tr("pullRequests.history.recordIncomplete")}</Text>
        </If>
      </View>
    </View>
  </If>;
}
