import { readFileSync, writeFileSync } from 'node:fs';
import { mergeTokenDocuments, resolveTokens } from '../design-system/tooling/token-engine/src/index.mjs';
import { resolveStatusColors } from '../design-system/packages/theme-openbitfun/scripts/resolve-status-colors.mjs';

const output = new URL('../src/nsh-ui/src/generated/designTokens.ts', import.meta.url);
const packages = new URL('../design-system/packages/', import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, packages), 'utf8'));
const system = resolveTokens(read('design-tokens/src/system.tokens.json'));
const reference = read('theme-openbitfun/src/reference.tokens.json');
const harnessModes = ['Minimal', 'Standard', 'Ultimate', 'Creative'];
const readArtwork = path => readFileSync(new URL(path, packages), 'utf8').trim().replace(/\r\n/g, '\n');

function tokenValue(tokens, name) {
  if (!Object.hasOwn(tokens, name)) throw new Error(`Missing design token: ${name}`);
  return tokens[name].value;
}

function pixels(name) {
  const value = tokenValue(system, name);
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?px$/.test(value)) {
    throw new Error(`Expected a pixel dimension for ${name}, got ${value}`);
  }
  return Number.parseFloat(value);
}

function flowChatDimensions() {
  const width = /^min\((\d+(?:\.\d+)?)%, (\d+(?:\.\d+)?)rem\)$/.exec(tokenValue(system, 'control.flowChat.userMessageMaxWidth'));
  const radius = /^calc\((\d+(?:\.\d+)?)px \+ (\d+(?:\.\d+)?)px\)$/.exec(tokenValue(system, 'control.flowChat.userMessageRadius'));
  const padding = /^(\d+(?:\.\d+)?)rem$/.exec(tokenValue(system, 'control.flowChat.userMessagePaddingBlock'));
  if (!width || !radius || !padding) throw new Error('Unsupported FlowChat user message dimensions');
  return {
    transcriptWidth: pixels('control.flowChat.transcriptMaxWidth'),
    metadataActionSize: pixels('control.flowChat.metadataActionSize'),
    metadataSize: pixels('type.flow.meta.fontSize'),
    metadataLineHeight: Number(tokenValue(system, 'type.flow.support.lineHeight')),
    metadataIconSize: pixels('control.icon.sizeXs'),
    userMessageWidthRatio: Number(width[1]) / 100,
    userMessageMaxWidth: Number(width[2]) * 16,
    userMessageRadius: Number(radius[1]) + Number(radius[2]),
    userMessagePaddingBlock: Number(padding[1]) * 16,
  };
}

// The app uses the same visual roles on each NSH target. These names are the
// existing NSH palette slots, mapped to the canonical design-system roles.
const paletteSources = {
  chromeBg: 'color.surface.chrome',
  chromeText: 'color.content.primary',
  chromeTextMuted: 'color.content.muted',
  chromeHover: 'color.action.neutral.surface',
  chromeActive: 'color.selection.surface',
  chromeBorder: 'color.border.subtle',
  chromeInputBg: 'color.field.background',
  canvas: 'color.surface.scene',
  canvasSubtle: 'color.surface.workbench',
  panel: 'color.surface.chrome',
  panelRaised: 'color.surface.raised',
  panelHover: 'color.action.neutral.surfaceHover',
  surfaceTertiary: 'color.surface.tertiary',
  surfaceSubtle: 'color.surface.subtle',
  surfaceElevated: 'color.surface.raised',
  popoverBg: 'color.surface.raised',
  inputBg: 'color.field.background',
  scrimBg: 'color.overlay.scrim',
  actionPrimaryBg: 'component.button.primaryBackground',
  actionPrimaryHover: 'component.button.primaryBackgroundHover',
  actionPrimaryPressed: 'component.button.primaryBackgroundPressed',
  actionPrimaryFg: 'color.action.primary.content',
  buttonSecondaryBg: 'color.surface.tertiary',
  buttonSecondaryHover: 'color.surface.tertiary',
  buttonSecondaryPressed: 'color.surface.tertiary',
  border: 'color.border.default',
  borderSubtle: 'color.border.subtle',
  borderStrong: 'color.border.strong',
  borderFocus: 'color.focus.ring',
  fieldFocusBorder: 'color.field.borderFocus',
  text: 'color.content.primary',
  textSecondary: 'color.content.secondary',
  textMuted: 'color.content.muted',
  textElevatedMuted: 'color.content.muted',
  warning: 'color.status.warning.content',
  warningSoft: 'color.status.warning.surface',
  warningBorder: 'color.status.warning.border',
  danger: 'color.status.danger.content',
  dangerSoft: 'color.status.danger.surface',
  dangerBorder: 'color.status.danger.border',
  success: 'color.status.success.content',
  successSoft: 'color.status.success.surface',
  successBorder: 'color.status.success.border',
  shadowCard: 'shadow.raised',
  shadowComposer: 'shadow.composer',
  shadowOverlay: 'shadow.overlay',
  userBubble: 'color.action.quiet.hover',
  userBubbleText: 'color.content.primary',
};

const controlSources = {
  quietActionHover: 'color.action.quiet.hover',
  buttonOutlineBorder: 'component.button.outlineBorder',
  buttonOutlineBorderInteractive: 'component.button.outlineBorderInteractive',
  buttonContent: 'component.button.content',
  buttonContentDisabled: 'color.action.neutral.contentDisabled',
  buttonPrimaryContentDisabled: 'component.button.primaryContentDisabled',
  buttonFill: 'component.button.fillBackground',
  fieldBorder: 'color.field.border',
  fieldBorderActive: 'color.field.borderActive',
  fieldBorderHover: 'color.field.borderHover',
  fieldBackgroundHover: 'color.field.backgroundHover',
  fieldPlaceholder: 'color.field.placeholder',
  contentDisabled: 'color.content.disabled',
  contentInverse: 'color.content.inverse',
  fieldGroupBackground: 'color.field.groupBackground',
  menuSurface: 'color.surface.panel',
  menuShadow: 'shadow.menu',
  rowSelection: 'color.selection.surface',
  actionCardSurface: 'color.actionCard.background',
  searchNewSession: 'color.identity.globalSearch.newSession',
  searchOpenBrowser: 'color.identity.globalSearch.openBrowser',
  searchOpenTerminal: 'color.identity.globalSearch.openTerminal',
  searchOpenProject: 'color.identity.globalSearch.openProject',
  searchNewProject: 'color.identity.globalSearch.newProject',
  searchOpenFiles: 'color.identity.globalSearch.openFiles',
  selectionIndicator: 'color.control.highlight.background',
  composerBorder: 'color.composer.border',
  toolCardSurface: 'color.surface.panel',
  diffAddedMarker: 'color.codeDiff.added.marker',
  diffRemovedMarker: 'color.codeDiff.removed.marker',
  switchTrack: 'color.control.switch.track',
  switchTrackChecked: 'color.control.switch.trackChecked',
  switchThumb: 'color.control.switch.thumb',
  segmentedTrack: 'color.action.neutral.surfaceHover',
  segmentedSelection: 'color.surface.raised',
  navigationHover: 'color.action.neutral.surface',
  navigationPressed: 'color.action.neutral.surfacePressed',
  navigationCaption: 'color.content.caption',
};

const skinPaletteSources = {
  ...paletteSources,
  accent: 'color.accent.default',
  accentHover: 'color.accent.hover',
  chromeAccent: 'color.accent.default',
};

function publicSkinTokenNames() {
  const light = resolveTokens(mergeTokenDocuments(reference, read('theme-openbitfun/src/light.tokens.json')));
  const publicTheme = /^(?:color\.|component\.(?:button|empty)\.|effect\.|opacity\.|shadow\.)/;
  return [...new Set([
    ...Object.keys(light).filter(name => publicTheme.test(name)),
    ...Object.keys(system).filter(name => name.startsWith('color.') || name.startsWith('shadow.')),
  ])].sort();
}

const skinTokenNames = publicSkinTokenNames();

function colorOverlay(color, opacity) {
  const translucent = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(color);
  if (translucent) {
    const [, red, green, blue, alpha] = translucent;
    return `rgba(${red}, ${green}, ${blue}, ${Number((Number(alpha) * opacity).toFixed(4))})`;
  }
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error(`Expected an opaque hex color, got ${color}`);
  const channels = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16));
  return `rgba(${channels.join(', ')}, ${opacity})`;
}

function resolveTheme(scheme) {
  const document = read(`theme-openbitfun/src/${scheme}.tokens.json`);
  const tokens = resolveStatusColors(resolveTokens(mergeTokenDocuments(reference, document)));
  const values = sources => Object.fromEntries(Object.entries(sources).map(([key, name]) => {
    const value = tokenValue(tokens, name);
    if (typeof value !== 'string' || value.includes('color-mix(')) {
      throw new Error(`Expected a concrete NSH theme value for ${name}, got ${value}`);
    }
    return [key, value];
  }));
  const palette = values(paletteSources);
  const controls = values(controlSources);
  return {
    skinPaintDefaults: Object.fromEntries(skinTokenNames.flatMap(name => {
      const value = (tokens[name] ?? system[name])?.value;
      return typeof value === 'string' ? [[name, value]] : [];
    })),
    harness: values(Object.fromEntries(harnessModes.map(mode =>
      [mode, `color.identity.harness.${mode.toLowerCase()}`]))),
    palette: {
      ...palette,
      shadowSceneEdge: scheme === 'dark'
        ? `-5px 0 16px -7px ${colorOverlay(tokenValue(tokens, 'color.content.onLight'), 0.3)}`
        : `-4px 0 12px -6px ${colorOverlay(palette.textMuted, 0.08)}`,
    },
    controls: {
      ...controls,
      disabledOpacity: Number(tokenValue(tokens, 'opacity.disabled')),
      mutedOpacity: Number(tokenValue(tokens, 'opacity.muted')),
      browserToolbar: colorOverlay(tokenValue(tokens, 'color.action.quiet.hover'), 0.7),
      sidebarSearch: colorOverlay(palette.canvas, 0.18),
      sidebarSearchHover: colorOverlay(palette.canvas, 0.28),
      sidebarSearchFocus: tokenValue(tokens, 'color.accent.default'),
      settingsSearchMatch: colorOverlay(tokenValue(tokens, 'color.accent.default'), 0.28),
      configRowHover: scheme === 'dark' ? controls.navigationHover : controls.quietActionHover,
    },
  };
}

const dimensions = sources => Object.fromEntries(
  Object.entries(sources).map(([key, name]) => [key, pixels(name)]),
);

const metrics = {
  welcomeTinyFontSize: pixels('type.flow.title.fontSize'),
  space: dimensions({ xs: 'space.1', sm: 'space.2', md: 'space.3', lg: 'space.4', xl: 'space.5', xxl: 'space.6', x3l: 'space.8', x4l: 'space.10', x5l: 'space.12', x6l: 'space.16' }),
  radius: dimensions({ xs: 'radius.xs', sm: 'radius.sm', md: 'radius.md', lg: 'radius.lg', xl: 'radius.xl', pill: 'radius.pill', scene: 'layout.splitView.contentPanelRadius' }),
  controlHeight: dimensions({ xs: 'control.button.xsHeight', sm: 'control.height.sm', md: 'control.height.md', lg: 'control.height.lg' }),
  buttonPadding: dimensions({ xs: 'control.button.xsPaddingInline', sm: 'space.4', md: 'space.5', lg: 'space.6' }),
  buttonFontSize: dimensions({ xs: 'type.meta.fontSize', sm: 'type.label.sm.fontSize', md: 'type.label.md.fontSize', lg: 'type.label.lg.fontSize' }),
  focus: dimensions({ width: 'focus.width', offset: 'focus.offset' }),
  disclosure: {
    ...dimensions({
      minHeight: 'layout.disclosure.triggerMinBlockSize',
      paddingBlock: 'layout.disclosure.triggerPaddingBlock',
      paddingInline: 'layout.disclosure.triggerPaddingInline',
      gap: 'layout.disclosure.triggerGap',
      radius: 'layout.disclosure.triggerRadius',
      indicator: 'layout.disclosure.indicatorSize',
      actionsGap: 'layout.disclosure.actionsGap',
      headingGap: 'space.1',
      contentPaddingBlock: 'layout.disclosure.contentPaddingBlock',
      contentPaddingInline: 'layout.disclosure.contentPaddingInline',
      summarySize: 'type.label.md.fontSize',
    }),
    summaryWeight: String(tokenValue(system, 'type.label.md.fontWeight')),
    summaryLineHeight: tokenValue(system, 'type.body.sm.lineHeight'),
  },
  numberInput: {
    ...dimensions({
      borderWidth: 'border.width.default',
      radius: 'radius.base',
      inputInset: 'space.3',
      inputUnitGap: 'space.1',
      unitInset: 'space.2',
      labelGap: 'space.2',
      fontSize: 'type.label.md.fontSize',
      unitFontSize: 'type.support.fontSize',
    }),
    fontWeight: String(tokenValue(system, 'type.label.md.fontWeight')),
    lineHeight: tokenValue(system, 'type.label.md.lineHeight'),
    unitFontWeight: String(tokenValue(system, 'type.support.fontWeight')),
    unitLineHeight: tokenValue(system, 'type.support.lineHeight'),
  },
  feedback: {
    alert: dimensions({
      gap: 'space.3',
      paddingBlock: 'space.3',
      paddingInline: 'space.4',
      radius: 'radius.base',
    }),
    statusPill: {
      ...dimensions({
        gap: 'control.statusPill.gap',
        paddingBlock: 'control.statusPill.paddingBlock',
        paddingInline: 'control.statusPill.paddingInline',
        radius: 'control.statusPill.radius',
        iconSize: 'control.statusPill.iconSize',
      }),
      fontSize: pixels('type.meta.fontSize'),
      lineHeight: tokenValue(system, 'type.statusPill.lineHeight'),
    },
    empty: dimensions({
      gap: 'layout.empty.gap',
      paddingBlock: 'layout.empty.paddingBlock',
      paddingInline: 'layout.empty.paddingInline',
      mediaSize: 'layout.empty.mediaSizeMd',
      iconSize: 'layout.empty.iconSizeMd',
    }),
  },
  dialog: {
    ...dimensions({
      viewportGutter: 'overlay.dialog.viewportGutter',
      surfaceRadius: 'overlay.dialog.surfaceRadius',
      headerPaddingTop: 'overlay.dialog.headerPaddingBlockStart',
      headerPaddingBottom: 'overlay.dialog.headerPaddingBlockEnd',
      headerPaddingInline: 'overlay.dialog.headerPaddingInline',
      contentPadding: 'overlay.dialog.contentPaddingLg',
      footerPaddingTop: 'overlay.dialog.footerPaddingBlockStart',
      footerPaddingBottom: 'overlay.dialog.footerPaddingBlockEnd',
      footerPaddingInline: 'overlay.dialog.footerPaddingInline',
      panelBlockSize: 'overlay.dialog.panelBlockSize',
      footerHeight: 'overlay.dialog.footerHeight',
      footerFadeExtent: 'overlay.dialog.footerFadeExtent',
      footerActionMinWidth: 'overlay.dialog.footerActionMinWidth',
    }),
    width: dimensions({
      sm: 'overlay.dialog.maxInlineSizeSmall',
      md: 'overlay.dialog.maxInlineSizeMedium',
      lg: 'overlay.dialog.maxInlineSizeLarge',
      xl: 'overlay.dialog.maxInlineSizeXlarge',
    }),
    backdropBlur: tokenValue(system, 'overlay.dialog.backdropBlur'),
  },
  tooltip: dimensions({
    maxInlineSize: 'overlay.tooltip.maxInlineSize',
    maxBlockSize: 'overlay.tooltip.maxBlockSize',
    paddingBlock: 'overlay.tooltip.paddingBlock',
    paddingInline: 'overlay.tooltip.paddingInline',
    radius: 'overlay.tooltip.surfaceRadius',
    gap: 'overlay.tooltip.gap',
  }),
  menu: dimensions({
    width: 'overlay.menu.inlineSize',
    maxHeight: 'overlay.menu.maxBlockSize',
    padding: 'overlay.menu.surfacePadding',
    radius: 'overlay.menu.surfaceRadius',
    rowGap: 'overlay.menu.rowGap',
    sectionGap: 'overlay.menu.sectionGap',
    headingHeight: 'overlay.menu.headingHeight',
    headingPadding: 'overlay.menu.headingPaddingInline',
    itemHeight: 'overlay.menu.itemHeight',
    itemPadding: 'overlay.menu.itemPaddingInline',
    itemGap: 'overlay.menu.itemGap',
    itemRadius: 'overlay.menu.itemRadius',
    itemIconSize: 'overlay.menu.itemIconSize',
  }),
  select: dimensions({
    padding: 'control.select.paddingInline',
    gap: 'control.select.contentGap',
    indicator: 'control.select.indicatorSize',
    radius: 'control.select.radius',
  }),
  tabGroup: {
    ...dimensions({
      gap: 'control.tabGroup.gap',
      radius: 'control.tabGroup.itemRadius',
      actionSize: 'control.tabGroup.itemActionSize',
    }),
    sm: dimensions({
      height: 'control.tabGroup.itemHeightSm',
      padding: 'control.tabGroup.itemPaddingInlineSm',
      gap: 'control.tabGroup.itemGapSm',
      iconSize: 'control.tabGroup.itemIconSizeSm',
    }),
    md: dimensions({
      height: 'control.tabGroup.itemHeight',
      padding: 'control.tabGroup.itemPaddingInline',
      gap: 'control.tabGroup.itemGap',
      iconSize: 'control.tabGroup.itemIconSize',
    }),
    selectedWeight: String(tokenValue(system, 'type.label.selected.fontWeight')),
  },
  card: dimensions({
    padding: 'layout.card.paddingMd',
    gap: 'layout.card.gapSm',
    radius: 'layout.card.radiusMd',
    headerGap: 'layout.card.headerGap',
    titleGap: 'layout.card.titleDescriptionGap',
    footerGap: 'layout.card.footerGap',
  }),
  toolbar: dimensions({
    smHeight: 'layout.toolbar.smHeight',
    mdHeight: 'layout.toolbar.mdHeight',
    contentGap: 'layout.toolbar.contentGap',
    smPaddingBlock: 'layout.toolbar.smPaddingBlock',
    smPaddingInline: 'layout.toolbar.smPaddingInline',
    mdPaddingTop: 'layout.toolbar.mdPaddingBlockStart',
    mdPaddingBottom: 'layout.toolbar.mdPaddingBlockEnd',
    mdPaddingLeft: 'layout.toolbar.mdPaddingInlineStart',
    mdPaddingRight: 'layout.toolbar.mdPaddingInlineEnd',
    groupGapSm: 'layout.toolbar.groupGapSm',
    groupGapMd: 'layout.toolbar.groupGapMd',
    separatorHeight: 'layout.toolbar.separatorBlockSize',
  }),
  confirmDialog: dimensions({
    contentGap: 'layout.confirmDialog.contentGap',
    messageGap: 'layout.confirmDialog.messageGap',
    iconSize: 'layout.confirmDialog.iconGlyphSize',
    previewMaxHeight: 'layout.confirmDialog.previewMaxBlockSize',
    previewPaddingBlock: 'layout.confirmDialog.previewPaddingBlock',
    previewPaddingInline: 'layout.confirmDialog.previewPaddingInline',
    previewRadius: 'layout.confirmDialog.previewRadius',
  }),
  actionCard: dimensions({
    compactHeight: 'control.actionCard.smMinBlockSize',
    minHeight: 'control.actionCard.mdMinBlockSize',
    paddingBlock: 'control.actionCard.paddingBlock',
    paddingInline: 'control.actionCard.paddingInline',
    radius: 'control.actionCard.radius',
    gap: 'control.actionCard.gap',
    leadingSize: 'control.actionCard.leadingSize',
    iconSize: 'control.actionCard.iconSize',
    contentGap: 'control.actionCard.contentGap',
  }),
  searchField: dimensions({
    sm: 'control.searchField.height.sm',
    md: 'control.searchField.height.md',
    lg: 'control.searchField.height.lg',
  }),
  searchDialog: dimensions({
    width: 'layout.searchDialog.width',
    height: 'layout.searchDialog.height',
    padding: 'layout.searchDialog.padding',
    scopeGap: 'layout.searchDialog.scopeGap',
    resultsGap: 'layout.searchDialog.resultsGap',
    viewportGutter: 'overlay.dialog.viewportGutter',
    radius: 'overlay.dialog.surfaceRadius',
  }),
  navigationPanel: {
    ...dimensions({
      width: 'layout.navigationPanel.inlineSize',
      padding: 'layout.navigationPanel.surfacePadding',
      gap: 'layout.navigationPanel.contentGap',
      sectionGap: 'layout.navigationPanel.sectionGap',
      headingHeight: 'layout.navigationPanel.headingHeight',
      headingPadding: 'layout.navigationPanel.headingPaddingInline',
      headingGap: 'layout.navigationPanel.headingGap',
      itemHeight: 'layout.navigationPanel.itemHeight',
      itemPadding: 'layout.navigationPanel.itemPaddingInline',
      itemGap: 'layout.navigationPanel.itemGap',
      itemRadius: 'layout.navigationPanel.itemRadius',
      iconSize: 'layout.navigationPanel.itemIconSize',
    }),
    selectedWeight: String(tokenValue(system, 'type.label.selected.fontWeight')),
  },
  formSection: dimensions({
    gap: 'layout.formSection.gap',
    headerGap: 'layout.formSection.headerGap',
    textGap: 'layout.formSection.titleDescriptionGap',
  }),
  fieldGroup: {
    ...dimensions({
      radius: 'layout.fieldGroup.radius',
      rowPaddingVertical: 'layout.fieldGroup.rowPaddingBlock',
      rowPaddingHorizontal: 'layout.fieldGroup.rowPaddingInline',
      rowGap: 'layout.field.horizontalGapWide',
      controlGap: 'layout.field.controlGap',
      labelGap: 'layout.field.labelGap',
      labelSize: 'type.label.selected.fontSize',
      descriptionSize: 'type.support.fontSize',
    }),
    descriptionLeading: tokenValue(system, 'type.modifier.leading.support.lineHeight'),
    labelLeading: tokenValue(system, 'type.label.selected.lineHeight'),
    labelWeight: String(tokenValue(system, 'type.label.selected.fontWeight')),
  },
  switch: dimensions({
    trackWidth: 'control.switch.trackWidth',
    trackHeight: 'control.switch.trackHeight',
    thumbSize: 'control.switch.thumbSize',
    thumbInset: 'control.switch.thumbInset',
    thumbTravel: 'control.switch.thumbTravel',
  }),
  segmented: {
    ...dimensions({
      gap: 'control.segmentedControl.gap',
      radius: 'control.segmentedControl.radius',
      itemRadius: 'control.segmentedControl.segmentRadius',
      itemGap: 'control.segmentedControl.segmentGap',
      fontSize: 'type.label.md.fontSize',
    }),
    sm: dimensions({
      padding: 'control.segmentedControl.padding',
      itemHeight: 'control.segmentedControl.segmentHeight',
      itemPadding: 'control.segmentedControl.segmentPaddingInline',
      iconSize: 'control.segmentedControl.iconSize',
    }),
    md: dimensions({
      padding: 'control.segmentedControl.paddingMd',
      itemHeight: 'control.segmentedControl.segmentHeightMd',
      itemPadding: 'control.segmentedControl.segmentPaddingInlineMd',
      iconSize: 'control.segmentedControl.iconSizeMd',
    }),
    lineHeight: tokenValue(system, 'type.body.sm.lineHeight'),
    weight: String(tokenValue(system, 'type.label.md.fontWeight')),
    selectedWeight: String(tokenValue(system, 'type.label.selected.fontWeight')),
  },
  flowChat: flowChatDimensions(),
  askUser: dimensions({
    headerHeight: 'control.askUser.headerHeight',
    iconSize: 'control.askUser.iconSize',
    bodyPadding: 'control.askUser.bodyPadding',
    inlinePadding: 'control.flowChat.cardPaddingInline',
    optionGap: 'control.askUser.optionGap',
    optionContentGap: 'control.askUser.optionContentGap',
    optionPaddingBlock: 'control.askUser.optionPaddingBlock',
    optionPaddingInline: 'control.askUser.optionPaddingInline',
    questionOptionsGap: 'control.askUser.questionOptionsGap',
    borderWidth: 'border.width.default',
  }),
  chatComposer: dimensions({
    compactHeight: 'control.chatComposer.compactHeight',
    compactGap: 'control.chatComposer.compactGap',
    compactTrackHeight: 'control.chatComposer.compactTrackHeight',
    compactPaddingBlock: 'control.chatComposer.compactPaddingBlock',
    compactPaddingInline: 'control.chatComposer.compactPaddingInline',
    controlHeight: 'control.chatComposer.controlHeight',
    actionIconSize: 'control.chatComposer.actionIconSize',
    expandedHeight: 'control.composer.minBlockSize',
    editorMinHeight: 'space.12',
    editorPadding: 'control.composer.editorPadding',
    expandedPadding: 'control.composer.surfacePadding',
    expandedGap: 'control.composer.surfaceGap',
    radius: 'control.composer.surfaceRadius',
    borderWidth: 'border.width.default',
    dividerHeight: 'control.composer.dividerBlockSize',
    modelNameWidth: 'control.flowChat.modelNameMaxWidth',
    textSize: 'type.flow.control.fontSize',
  }),
  toolCard: {
    ...dimensions({
      prominentHeight: 'control.activityItem.surfaceHeight',
      prominentRadius: 'control.activityItem.surfaceRadius',
      prominentPaddingBlock: 'control.activityItem.surfacePaddingBlock',
      prominentPaddingInline: 'control.flowChat.cardPaddingInline',
      borderWidth: 'border.width.default',
      iconSize: 'control.flowChat.rowIconSize',
      iconGap: 'control.flowChat.rowIconGap',
      fontSize: 'type.body.sm.fontSize',
      ambientBodySize: 'type.flow.body.fontSize',
      iconSlot: 'space.4',
      expandedPaddingInline: 'control.toolCard.expandedPaddingInline',
    }),
    titleWeight: String(tokenValue(system, 'type.label.lg.fontWeight')),
    lineHeight: Number(tokenValue(system, 'type.body.sm.lineHeight')),
    ambientBodyLineHeight: Number(tokenValue(system, 'type.flow.body.lineHeight')),
  },
  composer: {
    ...dimensions({
      radius: 'control.composer.surfaceRadius',
      padding: 'control.composer.surfacePadding',
      editorPadding: 'control.composer.editorPadding',
      editorMinHeight: 'space.12',
      editorFontSize: 'type.body.sm.fontSize',
      surfaceMinHeight: 'control.composer.minBlockSize',
      toolbarGap: 'control.composer.toolbarGap',
      surfaceGap: 'control.composer.surfaceGap',
      compactHeight: 'control.chatComposer.compactHeight',
      compactTrackHeight: 'control.chatComposer.compactTrackHeight',
      compactGap: 'control.chatComposer.compactGap',
      compactPaddingBlock: 'control.chatComposer.compactPaddingBlock',
      compactPaddingInline: 'control.chatComposer.compactPaddingInline',
      borderWidth: 'border.width.default',
      actionSize: 'control.chatComposer.controlHeight',
      actionIconSize: 'control.chatComposer.actionIconSize',
      dividerHeight: 'control.composer.dividerBlockSize',
    }),
    editorLineHeight: tokenValue(system, 'type.body.md.lineHeight'),
  },
};

const typographySources = {
  welcome: 'type.display.sm',
  display: 'type.heading.display',
  pageTitle: 'type.heading.page',
  modalTitle: 'type.heading.dialog',
  sectionTitle: 'type.heading.section',
  prose: 'type.flow.body',
  body: 'type.body.md',
  smallBody: 'type.body.sm',
  label: 'type.label.md',
  caption: 'type.body.xs',
  micro: 'type.label.xs',
  mono: 'type.code.sm',
  monoBlock: 'type.code.md',
  cardTitle: 'type.heading.card',
  meta: 'type.body.xs',
};

const typography = Object.fromEntries(Object.entries(typographySources).map(([role, name]) => {
  const tracking = tokenValue(system, `${name}.letterSpacing`);
  if (typeof tracking !== 'string' || !/^-?\d+(?:\.\d+)?em$/.test(tracking)) {
    throw new Error(`Expected an em dimension for ${name}.letterSpacing, got ${tracking}`);
  }
  return [role, {
    size: pixels(`${name}.fontSize`),
    weight: String(tokenValue(system, `${name}.fontWeight`)),
    lineHeight: tokenValue(system, `${name}.lineHeight`),
    tracking: Number.parseFloat(tracking),
  }];
}));

const data = {
  metrics,
  typography,
  skin: { names: skinTokenNames, paletteSources: skinPaletteSources, controlSources },
  fonts: { sans: tokenValue(system, 'font.family.sans'), mono: tokenValue(system, 'font.family.mono') },
  harnessArtwork: {
    modes: Object.fromEntries(harnessModes.map(mode =>
      [mode, readArtwork(`ui/src/components/Icon/assets/${mode.toLowerCase()}.svg`)])),
    actors: ['04', '01', '02', '06', '03'].map(id =>
      readArtwork(`ui/src/brand/assets/subagent-avatars/robot-${id}.svg`)),
  },
  light: resolveTheme('light'),
  dark: resolveTheme('dark'),
};

const source = '// Generated by scripts/generate-nsh-design-tokens.mjs from design-system token sources.\n'
  + `export const designTokens = ${JSON.stringify(data, null, 2)} as const;\n`;

if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8').replace(/\r\n/g, '\n') !== source) {
    console.error('NSH design tokens are stale. Run node scripts/generate-nsh-design-tokens.mjs.');
    process.exitCode = 1;
  }
} else {
  writeFileSync(output, source);
}
