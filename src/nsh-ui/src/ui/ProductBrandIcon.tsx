import { Image, signal } from "nsh";
import { isLightAppearance, palette } from "../theme";
import { Icon } from "./icons";
import { productBrandIcon } from "./productBrandIcons";

/** The surrounding control provides the application name. */
export function ProductBrandIcon(props: { productId: string; size?: number }) {
  const icon = () => productBrandIcon(props.productId);
  const size = () => props.size ?? 16;
  const source = () => isLightAppearance() ? icon()?.src : icon()?.darkSrc ?? icon()?.src;
  const failed = signal<string | undefined>(undefined);
  return (
    <If when={source() && failed() !== source() ? source() : undefined}
      else={<Icon name="bot" size={size()} color={palette().textMuted} />}>
      {current => <Image src={current()} onError={() => failed.set(current())}
        style={{ width: size(), height: size(), flexShrink: 0, objectFit: "contain",
          tintColor: icon()?.monochrome ? palette().text : undefined }} />}
    </If>
  );
}
