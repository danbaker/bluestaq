import * as Y from "yjs";

/**
 * The shared-type name the editor must use for the note body. "default" is what Tiptap's
 * Collaboration extension uses out of the box, so the frontend needs no extra configuration.
 */
export const BODY_FIELD = "default";

function nodeText(node: Y.XmlElement | Y.XmlText | Y.XmlHook | Y.XmlFragment): string {
  if (node instanceof Y.XmlText) {
    return node
      .toDelta()
      .map((op: { insert?: unknown }) => (typeof op.insert === "string" ? op.insert : ""))
      .join("");
  }
  if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
    const children = node.toArray() as (Y.XmlElement | Y.XmlText | Y.XmlHook)[];
    // Blocks (paragraphs, headings, list items) go on their own lines; inline text runs join together.
    const blocks = children.some((c) => !(c instanceof Y.XmlText));
    return children.map(nodeText).join(blocks ? "\n" : "");
  }
  return "";
}

/** Plain text of a note's body, for previews and search. */
export function extractText(doc: Y.Doc): string {
  return nodeText(doc.getXmlFragment(BODY_FIELD));
}
