// A local profile note is written as plain text and stored as HTML (accounts.note holds HTML for every row). The
// HTML is generated here only, so it can be turned back into the source (with line endings and blank lines
// normalized) for the edit form.

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const UNESCAPES: Record<string, string> = Object.fromEntries(Object.entries(ESCAPES).map(([k, v]) => [v, k]));

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

// Blank lines separate paragraphs; single newlines become <br>.
export function plainTextToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "")
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// The inverse of plainTextToHtml, for HTML it produced.
export function htmlToPlainText(html: string): string {
  return html
    .replace(/^<p>|<\/p>$/g, "")
    .split("</p><p>")
    .join("\n\n")
    .replace(/<br>/g, "\n")
    .replace(/&(amp|lt|gt|quot|#39);/g, (entity) => UNESCAPES[entity] ?? entity);
}
