// Splits a field's tooltip into the form section it belongs to and the item
// itself, so the review screen can group fields the way the form does.
//   "Part 1. Information About You. 2. Enter Given Name."
//     -> { section: "Part 1. Information About You", item: "2. Enter Given Name." }
// Periods followed by a non-space (as in "U.S.") don't end the section title.
const SECTION = /^((?:Part|Section)\s+\d+[A-Z]?\.\s+(?:[^.]|\.(?=\S))+)\.\s+(.+)$/i;

export function splitLabel(label: string): { section: string; item: string } {
  const m = label.match(SECTION);
  return m ? { section: m[1], item: m[2] } : { section: "", item: label };
}
