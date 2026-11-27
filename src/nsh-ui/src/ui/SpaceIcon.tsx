import { Text } from "nsh";
import { textLineHeight, textSize } from "../theme";
import { Icon, type IconName } from "./icons";
import { LUCIDE_PATHS } from "./lucideIcons";
import { firstAvatarGrapheme } from "./studio";

/**
 * Manifest icon names the desktop's miniAppIcons map knows (kebab-case lucide
 * names), projected onto glyphs this surface draws. Unknown names fall back
 * to the package glyph, as the desktop falls back to lucide's Box.
 */
const SPACE_ICON_MAP: Readonly<Record<string, IconName>> = {
  "app-window": "layers",
  aperture: "compass",
  bot: "bot",
  box: "package",
  code: "code",
  database: "database",
  "file-text": "file-text",
  "git-pull-request": "git-pull-request",
  globe: "globe",
  "grid-3x3": "layout-grid",
  grid3x3: "layout-grid",
  image: "image",
  "layout-grid": "layout-grid",
  "pen-tool": "edit",
  presentation: "monitor",
  regex: "hash",
  rocket: "zap",
  settings: "settings",
  sparkles: "sparkles",
  terminal: "terminal",
  workflow: "network",
  wrench: "wrench",
};

export function spaceIconName(icon: string): IconName {
  const key = icon
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
  return SPACE_ICON_MAP[key] ?? "package";
}

/**
 * A Space's icon as its manifest names it: an emoji is drawn as it is written
 * (the authoring guide's examples use them), a name as this surface's glyph.
 */
export function SpaceIcon(props: { icon: string; color: string; size?: number }) {
  const emoji = () => (/\p{Extended_Pictographic}/u.test(props.icon) ? firstAvatarGrapheme(props.icon) : "");
  return (
    <If when={emoji()} else={<Icon name={spaceIconName(props.icon)} size={props.size ?? 16} color={props.color} />}>
      {glyph => (
        <Text style={{ flexShrink: 0, fontSize: textSize(props.size ?? 13), lineHeight: textLineHeight(props.size ?? 13, 1.2), textAlign: "center" }}>
          {glyph()}
        </Text>
      )}
    </If>
  );
}

export function spaceSystemIconSvg(icon: string): string {
  const paths = LUCIDE_PATHS[spaceIconName(icon)] ?? LUCIDE_PATHS.package;
  const shapes = paths.map(path => `<path d="${path}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${shapes}</svg>`;
}
