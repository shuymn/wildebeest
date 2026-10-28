// The copy control: the server renders each control hidden, inside its CopyField (.copyfield), with the
// value in data-copy and the result texts from the catalogue in data-copied and data-failed; this shows the controls
// and, on a click, copies the value, marks the button's state (data-state: copied or failed, which the stylesheet
// shows by the icons the server rendered and by the failure's note, in space kept for it) and writes the result into
// the field's visually hidden role="status" element, for assistive technology. A success's state lasts COPIED_MS; a
// failure's until the next click. It holds no UI text, fetches nothing and writes only text and an attribute
// (textContent, setAttribute: no HTML sink, so Trusted Types needs no policy, WEB-2). Closing the field's dialog
// resets both, so a dialog opened again shows none. Without the Clipboard API (a page not in a secure context) the
// controls stay hidden.

// The one call of the Clipboard API the control makes.
export type Clip = { writeText(text: string): Promise<void> };

// How long a success shows its check before the button shows its copy icon again.
export const COPIED_MS = 2000;

const STATE = "data-state";

export function enableCopy(
  root: ParentNode,
  clipboard: Clip | undefined,
  later: (run: () => void, ms: number) => void = (run, ms) => void setTimeout(run, ms),
): void {
  if (clipboard === undefined) {
    return;
  }
  for (const button of root.querySelectorAll<HTMLButtonElement>(".copyfield button[data-copy]")) {
    const status = button.closest(".copyfield")?.querySelector('[role="status"]');
    if (status === null || status === undefined) {
      continue;
    }
    button.hidden = false;
    // The generation of the field's state: each reset (a click, the dialog closing) starts a new one, and a result
    // or a timer of an older one changes nothing, so a late result never shows after a close or over a newer click.
    let generation = 0;
    const reset = () => {
      generation++;
      button.removeAttribute(STATE);
      status.textContent = "";
    };
    button.closest("dialog")?.addEventListener("close", reset);
    button.addEventListener("click", () => {
      // Emptied first, so the same result is announced again on the next click.
      reset();
      const current = generation;
      const show = (state: "copied" | "failed") => {
        if (current !== generation) {
          return false;
        }
        button.setAttribute(STATE, state);
        status.textContent = button.getAttribute(`data-${state}`);
        return true;
      };
      clipboard.writeText(button.getAttribute("data-copy") ?? "").then(
        () => {
          if (show("copied")) {
            later(() => {
              if (current === generation) {
                button.removeAttribute(STATE);
              }
            }, COPIED_MS);
          }
        },
        () => void show("failed"),
      );
    });
  }
}
