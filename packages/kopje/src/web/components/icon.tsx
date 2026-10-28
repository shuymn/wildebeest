import type { FC } from "hono/jsx";

import { ICONS, type IconName, type IconSize } from "../icons";

// The icon contract: every call site chooses. A labelled icon is an image with its name; a decorative one is hidden
// from assistive technology and never focusable.
export type IconProps =
  | { name: IconName; size: IconSize; label: string; decorative?: never }
  | { name: IconName; size: IconSize; decorative: true; label?: never };

export const Icon: FC<IconProps> = (props) => {
  const a11y =
    props.decorative === true
      ? { "aria-hidden": "true" as const, focusable: "false" }
      : { role: "img", "aria-label": props.label };
  return (
    <svg class="ic" width={props.size} height={props.size} viewBox="0 0 24 24" {...a11y}>
      <path d={ICONS[props.name]} />
    </svg>
  );
};
