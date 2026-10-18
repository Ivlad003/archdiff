// Text written into the XML of the draw.io and ArchiMate files: the
// characters XML reserves escaped, and in an attribute a newline too
// (`&#xa;`), which a parser would otherwise read as a space.
//
// Entry points: `escapeXml`, `escapeXmlAttribute`.

/** Text for an element's content or a quoted attribute: `&`, `<`, `>` and `"` escaped. */
export function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Text for an attribute that may hold several lines (a draw.io label): newlines kept as `&#xa;`. */
export function escapeXmlAttribute(text: string): string {
  return escapeXml(text).replace(/\n/g, "&#xa;");
}
