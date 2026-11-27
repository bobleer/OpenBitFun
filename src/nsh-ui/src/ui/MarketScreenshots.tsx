import { cleanup, effect, Image, signal, Text, View } from "nsh";
import { invokeCommand } from "../bridge";
import { formatCount } from "../format";
import { isCommandUnavailable } from "../hostCommands";
import { tr } from "../i18n";
import { palette, radii, space, textStyle } from "../theme";
import { Spinner } from "./motion";
import { IconButton, InlineBanner } from "./primitives";
import { StudioSection } from "./studio";

const READ_SCREENSHOT = "miniapp_market_read_screenshot";

/** Requests one public screenshot at a time from the listing's runtime. */
export function MarketScreenshots(props: { hashes: readonly string[]; name: string }) {
  const index = signal(0);
  const attempt = signal(0);
  const source = signal("");
  const failure = signal<"unsupported" | "unavailable" | null>(null);
  const cache = new Map<string, string>();
  const current = () => Math.min(index(), props.hashes.length - 1);
  const altText = () => tr("spaces.detail.showcase", { name: props.name });

  effect(() => {
    const hash = props.hashes[current()];
    attempt();
    failure.set(null);
    const cached = hash ? cache.get(hash) : undefined;
    source.set(cached ?? "");
    if (!hash || cached) return;
    let active = true;
    cleanup(() => { active = false; });
    void invokeCommand<string>(READ_SCREENSHOT, { sha256: hash }).then(base64 => {
      if (!active) return;
      if (typeof base64 !== "string" || !base64) {
        failure.set("unavailable");
        return;
      }
      const image = `data:image/webp;base64,${base64}`;
      cache.set(hash, image);
      source.set(image);
    }).catch(error => {
      if (active) failure.set(isCommandUnavailable(error, READ_SCREENSHOT) ? "unsupported" : "unavailable");
    });
  });

  return (
    <StudioSection title={tr("market.preview")} accessibilityLabel="market-preview">
      <View style={{ width: "100%", aspectRatio: 16 / 9, alignItems: "center", justifyContent: "center",
        borderRadius: radii.lg, backgroundColor: palette().surfaceSubtle, overflow: "hidden" }}>
        <If when={source()}>
          {src => <Image src={src()} accessibilityLabel={altText()} style={{ width: "100%", height: "100%", objectFit: "contain" }}
            onError={() => {
              cache.delete(props.hashes[current()]);
              source.set("");
              failure.set("unavailable");
            }} />}
        </If>
        <If when={!source() && !failure()}>
          <Spinner size={18} />
        </If>
        <If when={failure() === "unsupported"}>
          <InlineBanner tone="neutral" message={tr("market.previewHostOutdated")} />
        </If>
        <If when={failure() === "unavailable"}>
          <InlineBanner tone="warning" message={tr("market.previewUnavailable")} actionLabel={tr("common.retry")}
            onAction={() => attempt.update(value => value + 1)} />
        </If>
      </View>
      <If when={props.hashes.length > 1}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm }}>
          <IconButton icon="chevron-left" testID="market-preview-previous" accessibilityLabel={tr("market.previewPrevious")}
            tooltip={tr("market.previewPrevious")}
            disabled={current() === 0} onPress={() => index.set(current() - 1)} />
          <Text style={{ ...textStyle("label"), color: palette().textSecondary }}>
            {tr("market.previewPosition", { current: formatCount(current() + 1), total: formatCount(props.hashes.length) })}
          </Text>
          <IconButton icon="chevron-right" testID="market-preview-next" accessibilityLabel={tr("market.previewNext")}
            tooltip={tr("market.previewNext")}
            disabled={current() >= props.hashes.length - 1} onPress={() => index.set(current() + 1)} />
        </View>
      </If>
    </StudioSection>
  );
}
