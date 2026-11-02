export type Fragment = { text: string; changed: boolean };
export type DiffLine = { text: string; fragments: Fragment[]; lineNumber: number };
export type DiffRow = { before: DiffLine | null; after: DiffLine | null };

type Match = [number, number];
type Budget = { similarities: number; words: number };
type Profile = { text: string; pairs: Map<string, number> };

const MAX_EXACT_MATCHES = 250_000;
const MIN_SIMILARITY = 0.45;

function lowerBound(values: number[], value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

// Hunt–Szymanski finds an exact line LCS without allocating a lines × lines table.
// Dense repeated lines use a monotone greedy fallback to keep the work bounded.
function exactMatches(left: string[], right: string[]): Match[] {
  const prefix: Match[] = [];
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) {
    prefix.push([start, start]);
    start++;
  }
  let leftEnd = left.length;
  let rightEnd = right.length;
  const suffix: Match[] = [];
  while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) {
    suffix.push([--leftEnd, --rightEnd]);
  }
  const positions = new Map<string, number[]>();
  for (let r = start; r < rightEnd; r++) {
    const existing = positions.get(right[r]);
    if (existing) existing.push(r);
    else positions.set(right[r], [r]);
  }
  let count = 0;
  for (let l = start; l < leftEnd; l++) count += positions.get(left[l])?.length ?? 0;
  const matches: Match[] = [];
  if (count > MAX_EXACT_MATCHES) {
    let next = start;
    for (let l = start; l < leftEnd; l++) {
      const candidates = positions.get(left[l]);
      if (!candidates) continue;
      const r = candidates[lowerBound(candidates, next)];
      if (r !== undefined) {
        matches.push([l, r]);
        next = r + 1;
      }
    }
  } else {
    const tails: number[] = [];
    const tailNodes: number[] = [];
    const nodes: { match: Match; previous: number }[] = [];
    for (let l = start; l < leftEnd; l++) {
      const candidates = positions.get(left[l]);
      if (!candidates) continue;
      for (let index = candidates.length - 1; index >= 0; index--) {
        const r = candidates[index];
        const length = lowerBound(tails, r);
        if (tails[length] === r) continue;
        const node = nodes.push({ match: [l, r], previous: tailNodes[length - 1] ?? -1 }) - 1;
        tails[length] = r;
        tailNodes[length] = node;
      }
    }
    let node = tailNodes.at(-1) ?? -1;
    while (node !== -1) {
      matches.push(nodes[node].match);
      node = nodes[node].previous;
    }
    matches.reverse();
  }
  return [...prefix, ...matches, ...suffix.reverse()];
}

function profile(text: string): Profile {
  const normalized = text.trim().replace(/\s+/g, ' ').toLowerCase();
  const pairs = new Map<string, number>();
  for (let index = 1; index < normalized.length; index++) {
    const pair = normalized.slice(index - 1, index + 1);
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
  }
  return { text: normalized, pairs };
}

function similarity(left: Profile, right: Profile): number {
  if (left.text === right.text) return 1;
  if (!left.text || !right.text) return 0;
  let common = 0;
  const [smaller, larger] =
    left.pairs.size < right.pairs.size ? [left.pairs, right.pairs] : [right.pairs, left.pairs];
  for (const [pair, count] of smaller) common += Math.min(count, larger.get(pair) ?? 0);
  const dice = (2 * common) / Math.max(1, left.text.length + right.text.length - 2);
  let prefix = 0;
  let suffix = 0;
  while (
    prefix < left.text.length &&
    prefix < right.text.length &&
    left.text[prefix] === right.text[prefix]
  )
    prefix++;
  while (
    suffix < left.text.length - prefix &&
    suffix < right.text.length - prefix &&
    left.text[left.text.length - suffix - 1] === right.text[right.text.length - suffix - 1]
  )
    suffix++;
  return Math.max(dice, (2 * (prefix + suffix)) / (left.text.length + right.text.length));
}

function editedMatches(
  left: Profile[],
  right: Profile[],
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
  budget: Budget,
): Match[] {
  const n = leftEnd - leftStart;
  const m = rightEnd - rightStart;
  if (!n || !m || !budget.similarities) return [];
  const matches: Match[] = [];
  if (n * m > budget.similarities) {
    // Large changed blocks get bounded lookahead; unmatched lines still appear in full.
    let next = rightStart;
    for (let l = leftStart; l < leftEnd && next < rightEnd && budget.similarities; l++) {
      let best = -1;
      let score = MIN_SIMILARITY;
      for (let r = next; r < Math.min(next + 32, rightEnd) && budget.similarities; r++) {
        budget.similarities--;
        const candidate = similarity(left[l], right[r]);
        if (candidate >= score) {
          if (candidate > score || best === -1) best = r;
          score = candidate;
        }
      }
      if (best !== -1) {
        matches.push([l, best]);
        next = best + 1;
      }
    }
    return matches;
  }
  budget.similarities -= n * m;
  const scores = new Float64Array(n * m);
  const width = m + 1;
  const lengths = new Float64Array((n + 1) * width);
  for (let l = n - 1; l >= 0; l--) {
    for (let r = m - 1; r >= 0; r--) {
      const score = similarity(left[leftStart + l], right[rightStart + r]);
      scores[l * m + r] = score >= MIN_SIMILARITY ? score : 0;
      lengths[l * width + r] = Math.max(
        lengths[(l + 1) * width + r],
        lengths[l * width + r + 1],
        score >= MIN_SIMILARITY ? score + lengths[(l + 1) * width + r + 1] : 0,
      );
    }
  }
  let l = 0;
  let r = 0;
  while (l < n && r < m) {
    const score = scores[l * m + r];
    if (score && score + lengths[(l + 1) * width + r + 1] >= lengths[l * width + r]) {
      matches.push([leftStart + l++, rightStart + r++]);
    } else if (lengths[(l + 1) * width + r] >= lengths[l * width + r + 1]) l++;
    else r++;
  }
  return matches;
}

function wordDifference(before: string, after: string, budget: Budget): [Fragment[], Fragment[]] {
  if (before === after)
    return [[{ text: before, changed: false }], [{ text: after, changed: false }]];
  const left = before.match(/\s+|[^\s]+/g) ?? [];
  const right = after.match(/\s+|[^\s]+/g) ?? [];
  if (left.length * right.length > budget.words) {
    let prefix = 0;
    let suffix = 0;
    while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix])
      prefix++;
    while (
      suffix < left.length - prefix &&
      suffix < right.length - prefix &&
      left[left.length - suffix - 1] === right[right.length - suffix - 1]
    )
      suffix++;
    const fragments = (tokens: string[]) => [
      { text: tokens.slice(0, prefix).join(''), changed: false },
      { text: tokens.slice(prefix, tokens.length - suffix).join(''), changed: true },
      { text: suffix ? tokens.slice(-suffix).join('') : '', changed: false },
    ];
    return [fragments(left), fragments(right)];
  }
  budget.words -= left.length * right.length;
  const width = right.length + 1;
  const lengths = new Uint16Array((left.length + 1) * width);
  for (let l = left.length - 1; l >= 0; l--)
    for (let r = right.length - 1; r >= 0; r--)
      lengths[l * width + r] =
        left[l] === right[r]
          ? lengths[(l + 1) * width + r + 1] + 1
          : Math.max(lengths[(l + 1) * width + r], lengths[l * width + r + 1]);
  const oldFragments: Fragment[] = [];
  const newFragments: Fragment[] = [];
  function append(target: Fragment[], text: string, changed: boolean) {
    const last = target.at(-1);
    if (last?.changed === changed) last.text += text;
    else target.push({ text, changed });
  }
  let l = 0;
  let r = 0;
  while (l < left.length || r < right.length) {
    if (l < left.length && r < right.length && left[l] === right[r]) {
      append(oldFragments, left[l++], false);
      append(newFragments, right[r++], false);
    } else if (
      r === right.length ||
      (l < left.length && lengths[(l + 1) * width + r] >= lengths[l * width + r + 1])
    ) {
      append(oldFragments, left[l++], true);
    } else append(newFragments, right[r++], true);
  }
  return [
    oldFragments.length ? oldFragments : [{ text: '', changed: true }],
    newFragments.length ? newFragments : [{ text: '', changed: true }],
  ];
}

/** Align complete lines; null is a spacer, while an empty DiffLine is a real blank line. */
export function alignText(before: string, after: string): DiffRow[] {
  const split = (text: string) => (text === '' ? [] : text.replace(/\r\n/g, '\n').split('\n'));
  const left = split(before);
  const right = split(after);
  const leftProfiles = left.map(profile);
  const rightProfiles = right.map(profile);
  const budget: Budget = { similarities: 40_000, words: 360_000 };
  const rows: DiffRow[] = [];
  const line = (text: string, index: number, changed: boolean): DiffLine => ({
    text,
    lineNumber: index + 1,
    fragments: [{ text, changed }],
  });
  let l = 0;
  let r = 0;
  function appendUntil(leftEnd: number, rightEnd: number) {
    while (l < leftEnd) rows.push({ before: line(left[l], l++, true), after: null });
    while (r < rightEnd) rows.push({ before: null, after: line(right[r], r++, true) });
  }
  for (const [leftAnchor, rightAnchor] of [
    ...exactMatches(left, right),
    [left.length, right.length] as Match,
  ]) {
    const edited = editedMatches(
      leftProfiles,
      rightProfiles,
      l,
      leftAnchor,
      r,
      rightAnchor,
      budget,
    );
    for (const [leftMatch, rightMatch] of edited) {
      appendUntil(leftMatch, rightMatch);
      const [oldFragments, newFragments] = wordDifference(left[l], right[r], budget);
      rows.push({
        before: { ...line(left[l], l++, true), fragments: oldFragments },
        after: { ...line(right[r], r++, true), fragments: newFragments },
      });
    }
    appendUntil(leftAnchor, rightAnchor);
    if (l < left.length && r < right.length)
      rows.push({ before: line(left[l], l++, false), after: line(right[r], r++, false) });
  }
  return rows;
}
