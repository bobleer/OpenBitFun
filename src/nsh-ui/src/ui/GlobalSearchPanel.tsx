import { cleanup, computed, effect, keymap, Overlay, Scroll, signal, Text, untracked, View, type InputRef, type ScrollRef, type ViewRef } from "nsh";
import { Input } from "nsh/base";
import { formatPlural } from "../format";
import { designTokens } from "../generated/designTokens";
import {
  closeGlobalSearch, effectiveSearchScope, refreshGlobalSearch, searchActionPrefix, searchBusy, searchItems,
  searchNotice, searchQuery, searchText, searchWorkspaceItems, setSearchQuery, setSearchScope,
  type SearchItem, type SearchScope,
} from "../globalSearchStore";
import { localizeHostError, tr, type MessageKey } from "../i18n";
import { activeWorkspaceId, deviceContext } from "../state";
import { compactLayout, controlHeight, designControlColors, palette, space, textSize, textStyle } from "../theme";
import { ActionCard } from "./ActionCard";
import { Icon, type IconName } from "./icons";
import { Spinner } from "./motion";
import { registerEscapeDismiss } from "./overlays";
import { Button, IconButton, InlineBanner, KbdHint } from "./primitives";
import { TabGroup } from "./TabGroup";
import { Toolbar } from "./Toolbar";

const metrics = designTokens.metrics.searchDialog;
const groups = [
  { kind: "command", title: "search.commands", icon: "command" },
  { kind: "capability", title: "search.features", icon: "sparkles" },
  { kind: "setting", title: "search.settings", icon: "settings" },
  { kind: "session", title: "search.sessions", icon: "chat" },
  { kind: "message", title: "search.messages", icon: "message-circle" },
  { kind: "file", title: "search.files", icon: "file-text" },
  { kind: "workspace", title: "search.workspaces", icon: "folder" },
  { kind: "assistant", title: "search.assistants", icon: "bot" },
] as const satisfies ReadonlyArray<{ kind: SearchItem["kind"]; title: MessageKey; icon: IconName }>;
const scopes = [["all", "search.scopeAll"], ["actions", "search.scopeActions"], ["content", "search.scopeContent"]] as const;
const frequentCommands = {
  "command:new-session": "searchNewSession",
  "command:browser": "searchOpenBrowser",
  "command:terminal": "searchOpenTerminal",
  "command:open-project": "searchOpenProject",
  "command:new-project": "searchNewProject",
  "command:files": "searchOpenFiles",
} as const;
type EntityKind = "workspace" | "assistant";

const summary = (count: number) => formatPlural(count, "format.resultOne", "format.resultOther");

export function GlobalSearchPanel(props: {
  commands: (query: string) => SearchItem[];
  settings: (query: string) => SearchItem[];
  capabilities: (query: string) => SearchItem[];
  activate: (item: SearchItem) => void;
  icon: (item: SearchItem, fallback: IconName) => IconName;
  shortcut: string;
}) {
  const selected = signal<string | null>(null);
  const selectedNode = signal<ViewRef | null>(null);
  const detail = signal<EntityKind | null>(null);
  const inputFocused = signal(false);
  const composing = signal(false);
  const width = signal<number>(metrics.width - 2 * metrics.padding);
  const itemRefs = new Map<string, ViewRef>();
  let input: InputRef | null = null;
  let scroll: ScrollRef | null = null;
  let lastBack = -Infinity;
  let context = [deviceContext(), activeWorkspaceId()];

  const views = computed(() => {
    const query = searchText();
    const scope = effectiveSearchScope();
    const overview = scope === "all" && !query;
    const commands = scope === "content" ? [] : props.commands(query);
    const items = [
      ...(overview ? Object.keys(frequentCommands).flatMap(id => commands.filter(item => item.id === id)) : commands),
      ...(scope === "content" ? [] : props.capabilities(query)),
      ...(scope === "all" && !searchActionPrefix() ? [...props.settings(query), ...searchWorkspaceItems(query)] : []),
      ...(scope === "actions" ? [] : searchItems()),
    ];
    return groups.flatMap(group => {
      if (detail() && group.kind !== detail()) return [];
      const rows = items.filter(item => item.kind === group.kind);
      if (!rows.length) return [];
      const entity = group.kind === "workspace" || group.kind === "assistant";
      const preview = entity && overview && !detail();
      return [{ ...group, rows: preview ? rows.slice(0, 1) : rows, total: rows.length,
        preview, grid: group.kind === "command" || group.kind === "capability" || group.kind === "setting" || (entity && !preview) }];
    });
  });
  const results = computed(() => views().flatMap(group => group.rows));
  const columns = () => width() < 420 ? 1 : width() < 560 ? 2 : 3;
  const highlight = (item: SearchItem | undefined, reveal = false) => {
    const node = item ? itemRefs.get(item.id) ?? null : null;
    selected.set(item?.id ?? null);
    selectedNode.set(node);
    if (reveal) node?.reveal({ vertical: "nearest", animated: false });
  };

  const reset = (group: EntityKind | null = null) => {
    detail.set(group);
    highlight(undefined);
    scroll?.scrollTo({ y: 0, animated: false });
  };
  effect(() => {
    const next = [deviceContext(), activeWorkspaceId()];
    if (next[0] === context[0] && next[1] === context[1]) return;
    context = next;
    untracked(() => { reset(); refreshGlobalSearch(); });
  });

  const dismiss = () => {
    if (composing()) return;
    if (detail()) {
      lastBack = Date.now();
      reset();
      input?.focus();
    } else if (Date.now() - lastBack > 150) {
      closeGlobalSearch();
    }
  };
  cleanup(registerEscapeDismiss(dismiss));

  const move = (key: string) => {
    const rows = results();
    const at = rows.findIndex(item => item.id === selected());
    switch (key) {
      case "down": highlight(rows[Math.min(rows.length - 1, at + 1)], true); break;
      case "up": highlight(rows[Math.max(0, at - 1)], true); break;
      case "home": highlight(rows[0], true); break;
      case "end": highlight(rows.at(-1), true); break;
    }
  };
  effect(() => {
    if (!inputFocused() || composing()) return;
    const navigate = ({ keystroke }: { keystroke: string }) => move(keystroke);
    return keymap.bind({ up: navigate, down: navigate, home: navigate, end: navigate },
      { when: "always", overFocused: true, repeat: true });
  });
  const submit = () => {
    if (composing()) return;
    const rows = results();
    const item = rows.find(entry => entry.id === selected()) ?? rows[0];
    if (item) props.activate(item);
  };
  const edit = (query: string) => { setSearchQuery(query); reset(); };
  const chooseScope = (next: SearchScope) => { setSearchScope(next); reset(); };
  const emptyLabel = () => effectiveSearchScope() === "content" && searchText().length < 2
    ? tr("search.typeForContent") : tr("search.noMatches");
  const horizontalInset = () => compactLayout() ? space.md : metrics.padding;

  return (
    <Overlay onCancel={dismiss} style={{ left: 0, top: 0, right: 0, bottom: 0, alignItems: "center",
      justifyContent: "center", padding: compactLayout() ? space.md : metrics.viewportGutter }}>
      <View focusable={false} onPress={closeGlobalSearch} style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0,
        backgroundColor: palette().scrimBg }} />
      <View role="dialog" accessibilityLabel="global-search-dialog" style={{
        width: "100%", maxWidth: metrics.width, height: metrics.height, maxHeight: "100%",
        minHeight: 0, flexShrink: 1, borderWidth: 1, borderColor: palette().borderSubtle,
        borderRadius: metrics.radius, borderCurve: "continuous", overflow: "hidden",
        backgroundColor: palette().surfaceElevated, boxShadow: palette().shadowOverlay,
      }}>
        <Toolbar size="md" style={{ paddingLeft: horizontalInset(), paddingRight: horizontalInset(), backgroundColor: "transparent" }}
          leading={<>
            <Icon name="search" size={16} color={palette().textMuted} />
            <Input ref={node => { input = node; }} autoFocus value={searchQuery()} submitBehavior="submit"
              role="combobox" accessibilityLabel="global-search-input"
              accessibilityState={{ expanded: true }} accessibilityActiveDescendant={selectedNode()}
              placeholder={tr("search.placeholder")} onChange={event => edit(event.value)} onSubmit={submit}
              onFocus={() => inputFocused.set(true)} onBlur={() => inputFocused.set(false)}
              onCompositionChange={event => composing.set(event.composing)}
              style={{ flex: 1, minWidth: 0, height: controlHeight.sm, backgroundColor: "transparent", borderWidth: 0,
                color: palette().text, placeholderColor: designControlColors()?.fieldPlaceholder ?? palette().textMuted,
                caretColor: palette().accent, fontSize: textSize(compactLayout() ? 16 : 14) }} />
            <If when={searchBusy()}><Spinner size={13} color={palette().accent} /></If>
            <If when={searchQuery().length > 0} else={!compactLayout() ? <KbdHint keys={props.shortcut} /> : undefined}>
              <Button label={tr("common.clear")} variant="ghost" size="xs" accessibilityLabel="global-search-clear"
                tooltip={tr("common.clearSearch")} onPress={() => { edit(""); input?.focus(); }} />
            </If>
          </>}
          trailing={<IconButton icon="close" size="sm" accessibilityLabel="global-search-close"
            tooltip={tr("common.closeEsc")} onPress={closeGlobalSearch} />} />
        <Scroll smoothWheel horizontal scrollbar={false} style={{ flexShrink: 0 }} contentStyle={{
          paddingHorizontal: horizontalInset(), paddingTop: compactLayout() ? space.sm : metrics.scopeGap,
          paddingBottom: space.xs,
        }}>
          <TabGroup size="sm" value={effectiveSearchScope()} onChange={chooseScope}
            items={scopes.map(([value, label]) => ({ value, label: tr(label),
              disabled: searchActionPrefix() && value !== "actions", testID: `global-search-scope-${value}` }))} />
        </Scroll>
        <Scroll smoothWheel ref={node => { scroll = node; }} role="listbox" scrollbar={true} style={{ flex: 1, minHeight: 0,
          marginTop: compactLayout() ? space.sm : metrics.resultsGap }} contentStyle={{
          paddingHorizontal: horizontalInset(), paddingBottom: space.md, gap: space.lg,
        }}>
          <If when={detail()}>
            <Button variant="ghost" size="xs" label={tr("search.groupBack")} leadingIcon="chevron-left"
              onPress={() => { reset(); input?.focus(); }} />
          </If>
          <If when={searchNotice()}>
            {notice => <InlineBanner tone="warning" message={localizeHostError(notice())} />}
          </If>
          <If when={results().length === 0 && !searchBusy()}>
            <Text style={{ ...textStyle("caption"), textAlign: "center", padding: space.lg }}>{emptyLabel()}</Text>
          </If>
          <View onLayout={event => { if (event.bounds.size.width > 0) width.set(event.bounds.size.width); }}
            style={{ flexDirection: "column", gap: space.lg }}>
            <Each of={views()} key={group => group.kind}>
              {group => {
                const count = () => group().grid ? columns() : 1;
                const itemWidth = () => (width() - (count() - 1) * space.sm) / count();
                return <View style={{ gap: space.sm }}>
                  <View style={{ flexDirection: "row", minHeight: controlHeight.xs, alignItems: "center",
                    justifyContent: "space-between", gap: space.sm }}>
                    <Text style={textStyle("label")}>{tr(group().kind === "command" && !searchText()
                      && effectiveSearchScope() === "all" ? "search.frequentActions" : group().title)}</Text>
                    <If when={group().preview && group().total > 1}>
                      <Button variant="ghost" size="xs" style={{ flexShrink: 0 }} trailingIcon="chevron-right"
                        label={summary(group().total)} onPress={() => { reset(group().kind as EntityKind); input?.focus(); }} />
                    </If>
                  </View>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
                    <Each of={group().rows} key={item => item.id}>
                      {item => <View style={{ width: itemWidth(), minWidth: 0 }}>
                        <ActionCard label={item().label} detail={group().kind === "command" && !searchText() ? undefined : item().detail}
                          icon={props.icon(item(), group().icon)} compact={group().kind === "command"}
                          iconColor={designControlColors()?.[frequentCommands[item().id as keyof typeof frequentCommands]]}
                          selected={selected() === item().id}
                          multilineDetail={group().kind === "message" || Boolean(item().controlDestination)}
                          testID={`global-search-item-${item().id}`} onHover={() => highlight(item())} onPress={() => props.activate(item())}
                          viewRef={node => {
                            if (node) itemRefs.set(item().id, node);
                            else itemRefs.delete(item().id);
                            if (selected() === item().id) selectedNode.set(node);
                          }} />
                      </View>}
                    </Each>
                  </View>
                </View>;
              }}
            </Each>
          </View>
        </Scroll>
        <If when={!compactLayout()}>
          <View style={{ flexDirection: "row", flexShrink: 0, alignItems: "center", justifyContent: "space-between",
            borderTopWidth: 1, borderColor: palette().borderSubtle, paddingHorizontal: horizontalInset(), paddingVertical: space.xs }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
              <KbdHint keys="↑↓" /><Text style={textStyle("caption")}>{tr("search.hintNavigate")}</Text>
              <KbdHint keys="↵" /><Text style={textStyle("caption")}>{tr("search.hintOpen")}</Text>
              <KbdHint keys="Esc" /><Text style={textStyle("caption")}>{tr("search.hintClose")}</Text>
            </View>
            <Text style={textStyle("caption", { tabular: true })}>{summary(results().length)}</Text>
          </View>
        </If>
      </View>
    </Overlay>
  );
}
