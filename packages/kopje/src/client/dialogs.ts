// Focus after a dialog opened from a popover: the browser returns focus to the dialog's opener when it closes, but an
// opener in a post's actions menu is hidden by then (opening the modal closed the menu), so focus would fall to the
// body. This remembers each dialog's opener from its show-modal command and, when the dialog closes with that opener in
// a closed popover, focuses the button that toggles the popover ("Share"). It only calls focus(): no HTML sink (WEB-2).
// Without script the browser's own behaviour stays.

// The parts of a CommandEvent (invoker commands) this reads; the DOM types may not have it yet.
type Command = Event & { command?: string; source?: Element | null };

export function returnFocus(root: Document): void {
  for (const dialog of root.querySelectorAll("dialog")) {
    let opener: Element | null | undefined;
    dialog.addEventListener("command", (event: Command) => {
      if (event.command === "show-modal") {
        opener = event.source;
      }
    });
    dialog.addEventListener("close", () => {
      const menu = opener?.closest("[popover]");
      if (menu === null || menu === undefined || menu.matches(":popover-open")) {
        return;
      }
      for (const trigger of root.querySelectorAll<HTMLElement>('[command="toggle-popover"]')) {
        if (trigger.getAttribute("commandfor") === menu.id) {
          trigger.focus();
        }
      }
    });
  }
}
