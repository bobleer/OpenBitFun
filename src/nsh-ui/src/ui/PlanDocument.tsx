import { cleanup, signal, Text, View, type JSX } from "nsh";
import { formatCount } from "../format";
import { tr } from "../i18n";
import type { PlanBuildStatus } from "../planBuildStore";
import { readPlanDocument, type PlanTodo } from "../planDocument";
import { palette, space, textStyle } from "../theme";
import { StateMark, type MarkState } from "./fleet";
import { Button, ConfigSection, IconButton, InlineBanner, InputBox } from "./primitives";

type Plan = Extract<ReturnType<typeof readPlanDocument>, { kind: "plan" }>;

function todoMark(status: string): MarkState {
  if (status === "completed") return "done";
  if (status === "cancelled") return "stopped";
  if (status === "in_progress") return "working";
  return "idle";
}

export function PlanTodoRows(props: { rows: ReadonlyArray<Pick<PlanTodo, "content" | "status">> }) {
  return <View style={{ gap: space.sm }}>
    <Each of={props.rows}>
      {row => {
        const closed = () => row().status === "completed" || row().status === "cancelled";
        return <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm }}>
          <StateMark state={todoMark(row().status)} />
          <Text style={{ flex: 1, minWidth: 0, ...textStyle("body", {
            color: closed() ? palette().textMuted : palette().text,
          }), textDecorationLine: closed() ? "line-through" : "none" }}>{row().content}</Text>
        </View>;
      }}
    </Each>
  </View>;
}

function PlanTodos(props: {
  plan: Plan;
  onChange: (markdown: string) => void;
  onEditingChange: (editing: boolean) => void;
  disabled?: boolean;
}) {
  const edit = signal<{ baseline: Plan; rows: PlanTodo[] } | null>(null);
  const applyError = signal(false);
  cleanup(() => props.onEditingChange(false));
  let nextTask = 0;
  const close = () => { edit.set(null); applyError.set(false); props.onEditingChange(false); };
  const changeRows = (change: (rows: PlanTodo[]) => PlanTodo[]) => {
    edit.update(draft => draft ? { ...draft, rows: change(draft.rows) } : null);
  };
  const stale = () => Boolean(edit() && edit()?.baseline !== props.plan);
  const canApply = () => Boolean(!props.disabled && !stale() && edit()?.rows.every(row => row.content.trim()));
  const remaining = () => props.plan.todos.filter(row => row.status !== "completed" && row.status !== "cancelled").length;

  return (
    <ConfigSection title={tr("plan.todos")}
      subtitle={props.plan.todos.length ? tr("plan.remaining", {
        count: formatCount(remaining()), total: formatCount(props.plan.todos.length),
      }) : tr("plan.noTodos")}
      extra={edit() ? undefined : <IconButton icon="edit" size="sm" tooltip={tr("plan.editTodos")}
        accessibilityLabel="plan-edit-todos" disabled={props.disabled}
        onPress={() => {
          edit.set({ baseline: props.plan, rows: props.plan.todos });
          props.onEditingChange(true);
        }} />}>
      <If when={edit()} else={<PlanTodoRows rows={props.plan.todos} />}>
        {draft => <View style={{ gap: space.sm }}>
          <If when={stale()}><InlineBanner tone="warning" message={tr("plan.staleTodos")} /></If>
          <If when={applyError()}><InlineBanner tone="warning" message={tr("plan.todoMetadataConflict")} /></If>
          <Each of={draft().rows} key={row => row.sourceIndex ?? row.id}>
            {(row, index) => <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <StateMark state={todoMark(row().status)} />
              <InputBox size="sm" style={{ flex: 1, minWidth: 0 }} value={row().content}
                placeholder={tr("plan.todoPlaceholder")} accessibilityLabel={`plan-todo-input-${index()}`}
                onChange={content => changeRows(rows => rows.map(item => item === row() ? { ...item, content } : item))} />
              <IconButton icon="trash" size="sm" tooltip={tr("plan.removeTodo")}
                accessibilityLabel={`plan-remove-todo-${index()}`}
                onPress={() => changeRows(rows => rows.filter(item => item !== row()))} />
            </View>}
          </Each>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>
            <Button label={tr("plan.addTodo")} variant="ghost" size="sm" leadingIcon="plus"
              accessibilityLabel="plan-add-todo" onPress={() => changeRows(rows => [...rows, {
                id: `todo-${Date.now().toString(36)}-${++nextTask}`, content: "", status: "pending", sourceIndex: null,
              }])} />
            <View style={{ flex: 1 }} />
            <Button label={tr("common.cancel")} size="sm" onPress={close} />
            <Button label={tr("common.apply")} size="sm" variant="primary" accessibilityLabel="plan-apply-todos"
              disabled={!canApply()} onPress={() => {
                if (!canApply()) return;
                const { baseline, rows } = draft();
                const previous = baseline.todos;
                if (rows.length !== previous.length || rows.some((row, index) => row !== previous[index])) {
                  try {
                    props.onChange(baseline.withTodos(rows));
                  } catch {
                    applyError.set(true);
                    return;
                  }
                }
                close();
              }} />
          </View>
        </View>}
      </If>
    </ConfigSection>
  );
}

export function PlanBuildButton(props: { status?: PlanBuildStatus; blocked?: string; accessibilityLabel?: string; onPress: () => void }) {
  const label = () => {
    switch (props.status) {
      case "sending": return tr("plan.sending");
      case "queued": return tr("plan.queued");
      case "building": return tr("plan.building");
      case "built": return tr("plan.built");
      case "failed": return tr("plan.retryBuild");
      default: return tr("plan.build");
    }
  };
  return <Button label={label()} variant="primary" size="sm" leadingIcon={props.status === "built" ? "check" : "play"}
    accessibilityLabel={props.accessibilityLabel ?? "plan-build"} loading={props.status === "sending" || props.status === "building"}
    disabled={Boolean(props.blocked) || props.status === "queued" || props.status === "built"} onPress={props.onPress} />;
}

export function PlanDocument(props: {
  plan: ReturnType<typeof readPlanDocument>;
  fileName: string;
  disabled?: boolean;
  buildStatus?: PlanBuildStatus;
  buildBlocked?: string;
  onBuild: () => void;
  onChange: (markdown: string) => void;
  renderMarkdown: (markdown: string, overview?: boolean) => JSX.Element;
}) {
  const details = () => props.plan.kind === "plan" ? props.plan : null;
  const editingTodos = signal(false);
  const blocked = () => editingTodos() ? tr("plan.applyBeforeBuild") : props.buildBlocked;
  const available = () => !props.buildStatus || props.buildStatus === "failed";
  return (
    <View accessibilityLabel="plan-document" style={{ gap: space.xl, minWidth: 0 }}>
      <If when={props.plan.kind === "invalid"}>
        <InlineBanner tone="warning" message={tr("plan.invalidMetadata")} />
      </If>
      <If when={details()}>
        {plan => <>
          <View style={{ gap: space.sm }}>
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm }}>
              <Text role="header" style={{ flex: 1, minWidth: 0, ...textStyle("pageTitle") }}>{plan().name || props.fileName}</Text>
              <PlanBuildButton status={props.buildStatus} blocked={blocked()} onPress={props.onBuild} />
            </View>
            <If when={available() && blocked()}>
              {notice => <Text style={textStyle("caption")}>{notice()}</Text>}
            </If>
            <If when={plan().overview}>{overview => props.renderMarkdown(overview(), true)}</If>
          </View>
          <PlanTodos plan={plan()} onChange={props.onChange} disabled={props.disabled} onEditingChange={editingTodos.set} />
        </>}
      </If>
      {props.renderMarkdown(props.plan.body)}
    </View>
  );
}
