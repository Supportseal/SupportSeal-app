/**
 * The widget bundles are maintained as readable ES5 sources but served as
 * plain JS strings, and their wire size is budgeted (DX-17: loader <= 5 KB,
 * collector <= 4 KB gzip). Comment-only lines exist for maintainers, not for
 * visitors, so they are dropped from the served artifact (issue #94: the
 * loader's growth past its budget was partly shipped commentary).
 *
 * Deliberately dumb: only whole lines whose first non-whitespace characters
 * are `//` are removed (plus blank-line runs squeezed to one). The widget
 * sources are constrained to no template literals and no multi-line string
 * literals (verified by the unit tests), so such a line can only be a
 * comment — a general-purpose minifier is not wanted here.
 */
export function stripWidgetComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*\/\//u.test(line))
    .join("\n")
    .replace(/\n{2,}/gu, "\n");
}
