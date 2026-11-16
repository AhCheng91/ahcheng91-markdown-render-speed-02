// Dependency-free Markdown -> HTML renderer matching marked 18.1.3 defaults.
// Clean-room implementation of CommonMark + GFM, derived from output rules.

const PUNCT = new Uint8Array(128);
for (const c of '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') PUNCT[c.charCodeAt(0)] = 1;
const UNI_PUNCT_RE = /[\p{P}\p{S}]/u;
function isPunct(code) {
  if (code < 128) return PUNCT[code] === 1;
  if (code >= 0xd800 && code <= 0xdfff) return false;
  return UNI_PUNCT_RE.test(String.fromCharCode(code));
}

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'blockquote', 'body', 'caption',
  'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir', 'div', 'dl',
  'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame',
  'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr',
  'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem', 'nav',
  'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'section', 'source',
  'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'title', 'tr',
  'track', 'ul',
]);

// ---------- line splitting ----------

function splitLines(md) {
  const lines = [];
  let start = 0;
  const n = md.length;
  while (start < n) {
    let e = md.indexOf('\n', start);
    let nl = true;
    if (e < 0) { e = n; nl = false; }
    let end = e;
    if (end > start && md.charCodeAt(end - 1) === 13) end--;
    lines.push({ t: md.slice(start, end), nl });
    start = e + 1;
  }
  if (n === 0) lines.push({ t: '', nl: false });
  return lines;
}

// ---------- block model ----------

function newBlock(type, parent) {
  return {
    type, parent,
    depth: parent ? parent.depth + 1 : 0,
    children: null,
    lines: null,
    open: true,
    // fence
    fenceChar: 0, fenceLen: 0, fenceIndent: 0, info: null,
    // heading / setext
    level: 0,
    // html block
    htmlKind: 0, htmlEnd: 0, htmlTag: null,
    // list / item
    ordered: false, marker: 0, delim: 0, start: 0, contentIndent: 0,
    blankAfter: false,
    // para lazy tracking
    lazyTail: false, stripDisabled: false, pendingBlank: false,
    // table
    align: null,
    finalNL: false,
  };
}

function addChild(parent, b) {
  if (parent.type === 'item') {
    if (b.type !== 'item' && (parent.blankSeen || parent.blankAbove)) parent.innerBlank = true;
    if (b.type !== 'item') parent.blankSeen = false;
  }
  if (parent.type === 'list' && b.type === 'item') {
    const ch = parent.children || [];
    const prev = ch[ch.length - 1];
    if (prev) {
      const deep = deepestItem(prev);
      if (prev.blankSeen || (deep && deep.blankSeen)) {
        parent.looseBySeparation = true;
        prev.blankSeen = false;
        if (deep) deep.blankSeen = false;
      }
    }
  }
  if (!parent.children) parent.children = [];
  parent.children.push(b);
  return b;
}

// ---------- helpers ----------

function isBlankAt(t, pos, end) {
  while (pos < end) {
    const c = t.charCodeAt(pos);
    if (c !== 32 && c !== 9) return false;
    pos++;
  }
  return true;
}

// consume up to `want` columns of spaces/tabs; returns [pos, col, pad]
// pad > 0 means a tab was partially consumed: pad spaces replace its remainder.
function takeIndent(t, pos, end, col, want) {
  let pad = 0;
  while (pos < end && want > 0) {
    const c = t.charCodeAt(pos);
    if (c === 32) { pos++; col++; want--; }
    else if (c === 9) {
      const w = 4 - (col & 3);
      if (w <= want) { pos++; col += w; want -= w; }
      else { pad = w - want; col += want; want = 0; pos++; }
    } else break;
  }
  return [pos, col, pad];
}

// measure full indent columns without consuming past non-space
function indentCols(t, pos, end, col) {
  const c0 = col;
  while (pos < end) {
    const c = t.charCodeAt(pos);
    if (c === 32) { pos++; col++; }
    else if (c === 9) { pos++; col = (col & ~3) + 4; }
    else break;
  }
  return [pos, col - c0];
}

// strip up to n leading spaces/tabs, returns [pos, col]
function skipSpace(t, pos, end, col, n) {
  while (pos < end && n > 0) {
    const c = t.charCodeAt(pos);
    if (c === 32) { pos++; col++; n--; }
    else if (c === 9) {
      const w = 4 - (col & 3);
      if (w > n) break;
      pos++; col += w; n -= w;
    } else break;
  }
  return [pos, col];
}

// ---------- document parse ----------

function parseDocument(md) {
  const lines = splitLines(md);
  const refs = new Map();
  const doc = newBlock('doc', null);
  const stack = [doc];
  let li = 0;
  while (li < lines.length) {
    li = incorporateLine(lines[li], li, lines, stack, refs);
  }
  closeAll(stack, lines);
  return { doc, refs };
}

// marked's inline lexer keeps inLink and linkEmitted in one state for the whole
// document: a start tag inside one block still holds it for the next block's text
let INLINE_STATE = null;

export function parse(markdown) {
  const md = typeof markdown === 'string' ? markdown.replace(/\r\n|\r/g, '\n') : '';
  const { doc, refs } = parseDocument(md);
  finalizeRefs(doc, refs);
  INLINE_STATE = { inLink: false, linkEmitted: false, inRawBlock: false, linkParenPossible: true };
  try {
    return renderBlocks(doc.children || [], refs, false, false);
  } finally {
    INLINE_STATE = null;
  }
}

// ---------- per-line incorporation ----------

// consume one column of "space after marker" (possibly a partial tab).
// returns [text, pos, col, n] with text rewritten if a tab was partially consumed
function applyOne(text, pos, col, n) {
  if (pos >= n) return [text, pos, col, n];
  const c = text.charCodeAt(pos);
  if (c === 32) return [text, pos + 1, col + 1, n];
  if (c === 9) {
    const w = 4 - (col & 3);
    if (w > 1) {
      return [' '.repeat(w - 1) + text.slice(pos + 1), 0, col + 1, w - 1 + text.length - pos - 1];
    }
    return [text, pos + 1, col + w, n];
  }
  return [text, pos, col, n];
}

function expandTabAt(text, pos, col, n) {
  if (pos >= n || text.charCodeAt(pos) !== 9) return [text, pos, col, n];
  const w = 4 - (col & 3);
  return [text.slice(0, pos) + ' '.repeat(w) + text.slice(pos + 1), pos, col, n + w - 1];
}

function expandLeadTabs(text, pos, col, n) {
  if (col === 0) return [text, pos, col, n];
  let i = pos, c = col, out = '', changed = false;
  while (i < n) {
    const ch = text.charCodeAt(i);
    if (ch === 32) { out += ' '; i++; c++; continue; }
    if (ch === 9) {
      const w = 4 - (c & 3);
      out += ' '.repeat(w);
      i++; c += w; changed = true; continue;
    }
    break;
  }
  if (!changed) return [text, pos, col, n];
  return [text.slice(0, pos) + out + text.slice(i), pos, col, n];
}
// a tab right after a block quote marker runs to the next tab stop measured from
// the marker's own width, and the marker takes only one space of it (marked's
// blockquoteMarkerWhitespace): expand the run so the rest is content
function expandQuoteMarkerTab(text, pos, p, n, col) {
  let e = pos;
  let tabbed = false;
  while (e < n) {
    const ch = text.charCodeAt(e);
    if (ch === 9) tabbed = true;
    else if (ch !== 32) break;
    e++;
  }
  if (!tabbed) return null;
  let out = '';
  let c2 = pos - p;
  for (let i = pos; i < e; i++) {
    if (text.charCodeAt(i) === 9) {
      const w = 4 - (c2 & 3);
      out += ' '.repeat(w);
      c2 += w;
    } else {
      out += ' ';
      c2++;
    }
  }
  return [text.slice(0, pos) + out + text.slice(e), col + out.length - (e - pos), text.length + out.length - (e - pos)];
}

function fenceInItem(b) {
  if (b.type !== 'fence') return false;
  // a fence that has taken no line but blank ones does not hold its item open:
  // the item text marked re-lexes ends at the first line that is not in the item
  if (!b.lines) return false;
  let hasContent = false;
  for (let i = 0; i < b.lines.length; i++) {
    if (b.lines[i] !== '') { hasContent = true; break; }
  }
  if (!hasContent) return false;
  let p = b.parent;
  while (p) {
    if (p.type === 'blockquote') return false;
    if (p.type === 'item') return true;
    p = p.parent;
  }
  return false;
}

function blankInContainers(line) {
  let s = line;
  for (;;) {
    const m = /^ {0,3}>/.exec(s);
    if (!m) break;
    s = s.slice(m[0].length);
    if (s.charAt(0) === ' ') s = s.slice(1);
  }
  return s.length === 0;
}

function hasQuoteAncestor(b) {
  let p = b.parent;
  while (p) {
    if (p.type === 'blockquote') return true;
    p = p.parent;
  }
  return false;
}

function hasItemAncestor(b) {
  let p = b.parent;
  while (p) {
    if (p.type === 'item') return true;
    p = p.parent;
  }
  return false;
}

// a fence's own line inside its block: marked strips up to the fence's
// indentation counted in characters, and only from ``` fences
function pushFenceLine(f, raw, blankLine) {
  if (f.fenceChar !== 96) {
    if (blankLine && hasItemAncestor(f)) { f.lines.push(''); return; }
    f.lines.push(raw);
    return;
  }
  let ws = 0;
  while (ws < raw.length && (raw.charCodeAt(ws) === 32 || raw.charCodeAt(ws) === 9)) ws++;
  const cut = ws < f.fenceIndent ? ws : f.fenceIndent;
  f.lines.push(raw.slice(cut));
}

function incorporateLine(line, li, lines, stack, refs) {
  let text = line.t;
  let pos = 0;
  let col = 0;
  let n = text.length;

  // Phase 1: match open containers
  let container = stack[0];
  let allMatched = true;
  let failedQuoteDepth = -1;
  let matchedDepth = 0;
  for (let d = 1; d < stack.length; d++) {
    const b = stack[d];
    if (b.type === 'list') { container = b; matchedDepth = d; continue; }
    if (b.type === 'blockquote') {
      let p = pos, c = col;
      const r = skipSpace(text, p, n, c, 3);
      if (text.charCodeAt(r[0]) === 62) {
        p = r[0] + 1; c = r[1] + 1;
        const ex1 = expandQuoteMarkerTab(text, p, r[0], n, c);
        if (ex1) { text = ex1[0]; c = ex1[1]; n = ex1[2]; }
        const q = applyOne(text, p, c, n);
        text = q[0]; pos = q[1]; col = q[2]; n = q[3];
        const q2 = expandLeadTabs(text, pos, col, n);
        text = q2[0]; pos = q2[1]; col = q2[2]; n = text.length;
        container = b; matchedDepth = d; continue;
      }
      allMatched = false; failedQuoteDepth = d; break;
    }
    if (b.type === 'item') {
      if (isBlankAt(text, pos, n)) { container = b; continue; }
      const want = b.contentIndent;
      const have = indentCols(text, pos, n, col)[1];
      if (have >= want) {
        const r = takeIndent(text, pos, n, col, want);
        if (r[2] > 0) {
          const rest = text.slice(r[0]);
          text = ' '.repeat(r[2]) + rest;
          pos = 0; col = col + want;
          n = text.length;
        } else { pos = r[0]; col = r[1]; }
        container = b; matchedDepth = d; continue;
      }
      // a table inside the item marked re-lexes takes this line as a row even
      // though the line is not indented into the item
      const deepT = stack[stack.length - 1];
      if (deepT && deepT.type === 'table' && hasItemAncestor(deepT) && isTableRow(text, pos, n, lines, li)) {
        container = deepT;
        matchedDepth = stack.length - 1;
        continue;
      }
      // item failed: the list cannot continue either
      container = (container && container.type === 'list') ? (container.parent || stack[0]) : container;
      allMatched = false; break;
    }
    // leaf block: it is the tip; it matched (all containers above matched);
    // container stays at its parent so interrupting starts open there
    if (d === stack.length - 1) { container = b.parent || stack[0]; break; }
    allMatched = false; break;
  }

  { const t = expandLeadTabs(text, pos, col, n); text = t[0]; pos = t[1]; col = t[2]; n = text.length; }
  let tip0 = stack[stack.length - 1];
  const rawWsOnly = isBlankAt(line.t, 0, line.t.length);
  const isLastLine = li === lines.length - 1;
  const paraOwnMatched = tip0.type === 'para' && container === stack[stack.length - 2];
  // closing fence check
  if (tip0.type === 'fence' && (allMatched || fenceInItem(tip0))) {
    let p = pos;
    const r0 = skipSpace(text, p, n, col, 3);
    p = r0[0];
    let len = 0;
    let ok = true;
    while (p < n && text.charCodeAt(p) === tip0.fenceChar) { p++; len++; }
    while (p < n) {
      const cc = text.charCodeAt(p);
      if (cc !== 32 && cc !== 9) { ok = false; break; }
      p++;
    }
    if (ok && len >= tip0.fenceLen) {
      tip0.open = false;
      const at = stack.lastIndexOf(tip0);
      if (at > 0) stack.length = at;
      return li + 1;
    }
  }
  const remWsOnly = isBlankAt(text, pos, n);
  // marked keeps a whitespace-only last line that has no line end after it: the
  // paragraph regex takes it as the paragraph's own end, spaces and all
  const tailSpace = rawWsOnly && isLastLine && !line.nl && tip0.type === 'para' && !hasQuoteAncestor(tip0);
  // marked's table body ends at a line of spaces only: a tab line is a row
  const tableTabRow = rawWsOnly && tip0.type === 'table' && line.t.indexOf('\t') >= 0;
  const blank = (rawWsOnly && !tailSpace && !tableTabRow) || pos >= n || (remWsOnly && !isLastLine && !tableTabRow);

  // blank line handling
  if (blank) {
    if (!allMatched) {
      closeUnmatched(stack, container);
      flagBlank(stack);
      markBlank(stack);
      return li + 1;
    }
    if (tip0.type === 'para') {
      tip0.open = false; tip0.blankAfter = true;
      stack.pop();
      flagBlank(stack);
      markBlank(stack);
    } else if (tip0.type === 'code' || tip0.type === 'fence') {
      if (tip0.type === 'fence') {
        let fenceHadContent = false;
        for (let q = 0; q < tip0.lines.length; q++) if (tip0.lines[q] !== '') { fenceHadContent = true; break; }
        pushFenceLine(tip0, text.slice(pos), true);
        // a blank line an empty fence takes still separates items in marked's re-lex
        if (!fenceHadContent) {
          const it = lastItem(stack);
          if (it) it.blankSeen = true;
        }
      } else {
        const r = takeIndent(text, pos, n, col, 4);
        tip0.lines.push(r[2] > 0 ? ' '.repeat(r[2]) + text.slice(r[0]) : text.slice(r[0]));
      }
    } else if (tip0.type === 'html' && tip0.htmlKind >= 1 && tip0.htmlKind <= 5) {
      tip0.lines.push({ t: text.slice(pos), nl: line.nl });
    } else if (tip0.type === 'html' || tip0.type === 'table') {
      tip0.open = false; tip0.blankAfter = true;
      stack.pop();
      flagBlank(stack);
      markBlank(stack);
    } else if (tip0.type === 'list') {
      // a blank line after a list whose items are all closed ends the list
      tip0.open = false;
      stack.pop();
      flagBlank(stack);
      markBlank(stack);
    } else {
      const it = lastItem(stack);
      if (it && (!it.children || it.children.length === 0)) {
        // an item that never got content cannot continue past a blank line
        it.blankSeen = true;
        closeUnmatched(stack, it.parent || stack[0]);
        flagBlank(stack);
        return li + 1;
      }
      flagBlank(stack);
      markBlank(stack);
    }
    return li + 1;
  }

  // a container above the deepest matched one failed: close it and everything under it
  if (!allMatched && tip0.type !== 'para' && !fenceInItem(tip0)) {
    closeUnmatched(stack, stack[matchedDepth] || stack[0]);
    tip0 = stack[stack.length - 1];
    container = tip0.type === 'list' ? (tip0.parent || stack[0]) : tip0;
    matchedDepth = stack.length - 1;
    allMatched = true;
  }

  // Phase 2: block starts
  let consumed = false; // leaf start consumed the line
  let guard = 0;
  while (!consumed && guard++ < 64) {
    const tipNow = stack[stack.length - 1];
    const paraTip = tipNow.type === 'para';
    const containerTip = tipNow.type === 'doc' || tipNow.type === 'blockquote' || tipNow.type === 'item' || tipNow.type === 'list';
    if (tipNow.type === 'fence' || tipNow.type === 'html') {
      if (allMatched) break; // absorb
    } else if (tipNow.type === 'code') {
      const have4 = indentCols(text, pos, n, col)[1];
      if (allMatched) {
        if (have4 >= 4) break; // absorb
        tipNow.open = false; stack.pop();
        continue;
      }
    } else if (tipNow.type === 'table') {
      if (allMatched) {
        if (isTableRow(text, pos, n, lines, li)) break; // row absorbed in phase 3
        tipNow.open = false;
        stack.pop();
        container = stack[stack.length - 1];
        matchedDepth = stack.length - 1;
        continue;
      } else {
        closeUnmatched(stack, container); continue;
      }
    }
    if (!containerTip && !paraTip && tipNow.type !== 'table' && allMatched) break;

    const interrupt = paraTip;
    let p = pos, c = col;

    // lazy line whose own container failed: special handling
    if (paraTip && !paraOwnMatched) {
      // a) thematic break wins
      if (isThematic(text, p, n)) {
        closeUnmatched(stack, container);
        const h = addChild(container, newBlock('hr', container));
        h.open = false;
        return li + 1;
      }
      // b) any list marker interrupts (no restrictions in lazy context)
      if (peekListMarker(text, p, n)) {
        closeUnmatched(stack, stack[matchedDepth] || stack[0]);
        const base = stack[stack.length - 1];
        const liRes = tryListItem(text, p, n, c, stack, base, false, refs, lines, li, stack.length - 1);
        if (liRes) {
          pos = liRes[0]; col = liRes[1];
          if (liRes[2]) { text = liRes[3]; pos = 0; col = liRes[1]; n = liRes[4]; }
          container = stack[stack.length - 1];
          continue;
        }
      }
      // c) underline-shaped lazy line
      if (isLazyUnderline(text, p, n)) {
        if (tip0.parent && tip0.parent.type === 'blockquote' && tip0.lazyTail) {
          tip0.lines.push('    ' + text.slice(p).replace(/^[ \t]+/, ''));
          tip0.lazyTail = true;
          return li + 1;
        }
        if (tip0.parent && tip0.parent.type === 'item' && failedQuoteDepth >= 1 && failedQuoteDepth < stack.length - 2) {
          tip0.level = text.charCodeAt(p) === 61 ? 1 : 2;
          tip0.type = 'setext'; tip0.open = false;
          stack.pop();
          return li + 1;
        }
      }
      // d) block starts that interrupt a paragraph
      // a table interrupts the paragraph and stays in the item marked re-lexes
      if (li + 1 < lines.length && tryTableStart(text, p, n, li, lines, true) &&
          tip0.parent && tip0.parent.type === 'item') {
        closeUnmatched(stack, tip0.parent);
        tip0.open = false;
        container = tip0.parent;
        matchedDepth = stack.length - 1;
        allMatched = true;
        continue;
      }
      if (tryHtmlStart(text, p, n, true) || tryFence(text, p, n) || tryAtx(text, p, n) ||
          (li + 1 < lines.length && !!tryTableStart(text, p, n, li, lines, true)) ||
          (!interruptQuote(text, p, n))) {
        closeUnmatched(stack, stack[matchedDepth] || stack[0]);
        container = stack[stack.length - 1];
        if (container.type === 'list') container = container.parent || stack[0];
        matchedDepth = stack.length - 1;
        allMatched = true;
        continue;
      }
      // e) strip-run or verbatim lazy
      pushLazyLine(tip0, text.slice(p), isLastLine);
      return li + 1;
    }

    // setext underline (only when all containers matched and para tip)
    if (allMatched && paraTip) {
      const u = setextLevel(text, p, n);
      // marked's lheading lookahead refuses a paragraph that opens a fence line,
      // an ATX heading, a list item, a block quote or an indented code line
      if (u > 0 && (tipNow.lines.length === 0 || !setextHead(tipNow.lines[0]))) {
        closeUnmatched(stack, container);
        parseRefDefs(tipNow, refs);
        if (tipNow.lines.length === 0) {
          const par = tipNow.parent;
          if (par && par.children && par.children[par.children.length - 1] === tipNow) par.children.pop();
        } else {
          tipNow.level = u; tipNow.type = 'setext'; tipNow.open = false;
          return li + 1;
        }
      }
    }

    // blockquote marker
    if (!interrupt || canInterrupt(text, p, n, 'quote')) {
      const r = skipSpace(text, p, n, c, 3);
      if (text.charCodeAt(r[0]) === 62) {
        closeUnmatched(stack, container);
        const par = container;
        const q2 = addChild(par, newBlock('blockquote', par));
        stack.push(q2);
        pos = r[0] + 1; col = r[1] + 1;
        const ex2 = expandQuoteMarkerTab(text, pos, r[0], n, col);
        if (ex2) { text = ex2[0]; col = ex2[1]; n = ex2[2]; }
        const q3 = applyOne(text, pos, col, n);
        text = q3[0]; pos = q3[1]; col = q3[2]; n = q3[3];
        const q4 = expandLeadTabs(text, pos, col, n);
        text = q4[0]; pos = q4[1]; col = q4[2]; n = text.length;
        container = q2;
        continue;
      }
    }

    // ATX heading
    const atx = tryAtx(text, p, n);
    if (atx) {
      closeUnmatched(stack, container);
      const h = addChild(container, newBlock('heading', container));
      h.level = atx[0]; h.content = atx[1];
      h.open = false;
      return li + 1;
    }

    // fenced code
    const fence = tryFence(text, p, n);
    if (fence) {
      closeUnmatched(stack, container);
      const f = addChild(container, newBlock('fence', container));
      f.fenceChar = fence[0]; f.fenceLen = fence[1]; f.fenceIndent = fence[2]; f.info = fence[3];
      f.lines = [];
      stack.push(f);
      return li + 1;
    }

    // HTML block start
    const htmlStart = tryHtmlStart(text, p, n, interrupt);
    if (htmlStart) {
      closeUnmatched(stack, container);
      const h = addChild(container, newBlock('html', container));
      h.htmlKind = htmlStart[0]; h.htmlEnd = htmlStart[1]; h.htmlTag = htmlStart[2];
      h.lines = [{ t: text.slice(p), nl: line.nl }];
      stack.push(h);
      if (h.htmlKind >= 1 && h.htmlKind <= 5 && scanHtmlEnd(h.lines[0].t, h.htmlKind)) {
        h.open = false;
        const nxt = li + 1 < lines.length ? lines[li + 1] : null;
        h.endNL = line.nl && !(nxt && blankInContainers(nxt.t));
        stack.pop();
      }
      return li + 1;
    }

    // thematic break
    if (isThematic(text, p, n)) {
      closeUnmatched(stack, container);
      const h = addChild(container, newBlock('hr', container));
      h.open = false;
      return li + 1;
    }

    // table start (needs lookahead to next line)
    if (li + 1 < lines.length && (!interrupt || true)) {
      const tbl = tryTableStart(text, p, n, li, lines, interrupt);
      if (tbl) {
        closeUnmatched(stack, container);
        const tb = addChild(container, newBlock('table', container));
        tb.align = tbl[1]; tb.header = tbl[0]; tb.lines = [];
        stack.push(tb);
        return li + 2; // header + delimiter consumed
      }
    }

    // list item
    const item = tryListItem(text, p, n, c, stack, container, interrupt, refs, lines, li, stack.length - 1);
    if (item) {
      pos = item[0]; col = item[1];
      if (item[2]) {
        text = item[3];
        pos = 0; col = item[1];
        n = item[4];
      }
      container = stack[stack.length - 1];
      continue;
    }

    // indented code (container tip only, not interrupting para)
    if (!interrupt) {
      const have = indentCols(text, p, n, c)[1];
      if (have >= 4) {
        closeUnmatched(stack, container);
        const cb = addChild(container, newBlock('code', container));
        cb.lines = [];
        stack.push(cb);
        consumed = true;
        break;
      }
    }

    if (interrupt && !allMatched) break; // lazy continuation
    break;
  }

  // Phase 3: add text
  let tipNow = stack[stack.length - 1];
  if (!consumed && !allMatched && !fenceInItem(tipNow) && (tipNow.type === 'fence' || tipNow.type === 'html' || tipNow.type === 'code' || tipNow.type === 'table')) {
    closeUnmatched(stack, container);
    tipNow = stack[stack.length - 1];
  }
  if (tipNow.type === 'para') {
    if (tipNow.pendingBlank) { tipNow.lines.push(''); tipNow.pendingBlank = false; }
    let lineTxt = text.slice(pos);
    // marked re-lexes a list item's text, where a continuation line indented four
    // or more columns loses that indent before it becomes paragraph text
    tipNow.lastDeep = false;
    if (hasItemAncestor(tipNow) && !hasQuoteAncestor(tipNow)) {
      const ind = indentCols(text, pos, n, col);
      if (ind[1] >= 4) {
        const t2 = takeIndent(text, pos, n, col, 4);
        lineTxt = (t2[2] > 0 ? ' '.repeat(t2[2]) : '') + text.slice(t2[0]);
        tipNow.lastDeep = true;
      }
    }
    tipNow.lines.push(lineTxt);
    tipNow.lazyTail = !allMatched;
    return li + 1;
  }
  if (tipNow.type === 'code') {
    const r = takeIndent(text, pos, n, col, 4);
    let s;
    if (r[2] > 0) s = ' '.repeat(r[2]) + text.slice(r[0]);
    else s = text.slice(r[0]);
    tipNow.lines.push(s);
    return li + 1;
  }
  if (tipNow.type === 'fence') {
    // marked strips up to the fence's own indentation from each line, counted in
    // characters (a tab is one), never in columns
    pushFenceLine(tipNow, text.slice(pos), false);
    return li + 1;
  }
  if (tipNow.type === 'html') {
    const ln = { t: text.slice(pos), nl: line.nl };
    tipNow.lines.push(ln);
    if (tipNow.htmlKind >= 1 && tipNow.htmlKind <= 5) {
      const e = scanHtmlEnd(ln.t, tipNow.htmlKind);
      if (e) {
        tipNow.open = false;
        const nxt = li + 1 < lines.length ? lines[li + 1] : null;
        tipNow.endNL = ln.nl && !(nxt && blankInContainers(nxt.t));
        stack.pop();
      }
    }
    return li + 1;
  }
  if (tipNow.type === 'table') {
    tipNow.lines.push(text.slice(pos));
    return li + 1;
  }
  if (tipNow.type === 'doc' || tipNow.type === 'blockquote' || tipNow.type === 'item' || tipNow.type === 'list') {
    closeUnmatched(stack, container);
    if (!isBlankAt(text, pos, n)) {
      let par = stack[stack.length - 1];
      if (par.type === 'list') {
        // a list with no open item cannot hold a paragraph
        stack.pop();
        par.open = false;
        par = stack[stack.length - 1];
      }
      const para = addChild(par, newBlock('para', par));
      para.lines = [text.slice(pos)];
      stack.push(para);
    }
    return li + 1;
  }
  return li + 1;
}

function interruptQuote(t, pos, end) {
  const r = skipSpace(t, pos, end, 0, 3);
  return t.charCodeAt(r[0]) !== 62;
}

function peekListMarker(t, pos, end) {
  let p = pos;
  const r = skipSpace(t, p, end, 0, 3);
  p = r[0];
  if (p >= end) return false;
  const c = t.charCodeAt(p);
  if (c === 45 || c === 43 || c === 42) return true;
  if (c >= 48 && c <= 57) {
    let j = p;
    let digits = 0;
    while (j < end && t.charCodeAt(j) >= 48 && t.charCodeAt(j) <= 57) { j++; digits++; }
    const dc = t.charCodeAt(j);
    if (digits >= 1 && digits <= 9 && (dc === 46 || dc === 41)) return true;
  }
  return false;
}

function isLazyUnderline(t, pos, end) {
  let p = pos;
  const r = skipSpace(t, p, end, 0, 3);
  p = r[0];
  if (p >= end) return false;
  const c = t.charCodeAt(p);
  if (c !== 61 && c !== 45) return false;
  let count = 0;
  while (p < end && t.charCodeAt(p) === c) { p++; count++; }
  if (c === 45 && count < 2) return false;
  while (p < end) {
    const cc = t.charCodeAt(p);
    if (cc !== 32 && cc !== 9) return false;
    p++;
  }
  return true;
}

function pushLazyLine(para, content, isLastLine) {
  if (para.stripDisabled !== true && leadingWsCols(content) >= 4) {
    para.lines.push(dedent4(content));
    para.pendingBlank = true;
    para.lazyTail = true;
    para.lastDeep = true;
    return;
  }
  if (para.pendingBlank) { para.lines.push(''); para.pendingBlank = false; }
  para.lines.push(content);
  para.lazyTail = true;
  para.stripDisabled = true;
}

function leadingWsCols(s) {
  let i = 0, col = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32) { i++; col++; }
    else if (c === 9) { i++; col = (col & ~3) + 4; }
    else break;
  }
  return col;
}

function dedent4(s) {
  let i = 0, col = 0;
  while (i < s.length && col < 4) {
    const c = s.charCodeAt(i);
    if (c === 32) { i++; col++; }
    else if (c === 9) { const w = 4 - (col & 3); i++; col += w; }
    else break;
  }
  return s.slice(i);
}

function flagBlank(stack) {
  for (const b of stack) b.blankAfter = true;
}

function lastItem(stack) {
  for (let k = stack.length - 1; k >= 0; k--) {
    const b = stack[k];
    if (b.type === 'item') return b;
    if (b.type === 'doc' || b.type === 'blockquote') return null;
  }
  return null;
}

function markBlank(stack) {
  let first = true;
  let any = null;
  for (let k = stack.length - 1; k >= 0; k--) {
    const b = stack[k];
    if (b.type === 'blockquote') break; // a blank inside a quote is not the list's
    if (b.type === 'item') {
      if (first) { b.blankSeen = true; any = b; first = false; }
      else b.blankAbove = true;
    }
  }
  return any;
}

// deepest item reachable through trailing lists of an item's children
function deepestItem(item) {
  let ch = item.children;
  while (ch && ch.length) {
    const last = ch[ch.length - 1];
    if (last.type === 'item') return last;
    if (last.type === 'list') {
      const items = last.children;
      if (!items || !items.length) return null;
      const li = items[items.length - 1];
      if (li.type !== 'item') return null;
      const deeper = deepestItem(li);
      return deeper || li;
    }
    return null;
  }
  return null;
}

function closeUnmatched(stack, container) {
  while (stack.length > 1 && stack[stack.length - 1] !== container) {
    const b = stack.pop();
    b.open = false;
  }
}

function closeAll(stack, lines) {
  while (stack.length > 1) {
    const b = stack.pop();
    b.open = false;
    if (b.type === 'html' && b.lines && b.lines.length) {
      b.endNL = b.lines[b.lines.length - 1].nl;
    }
  }
}

// ---------- block start helpers ----------

function setextHead(first) {
  return /^ {0,3}(?:`{3,}|~{3,})/.test(first) || /^ {0,3}#{1,6}(?:\s|$)/.test(first) ||
    /^ {0,3}>/.test(first) || /^ {0,3}(?:[*+-]|\d{1,9}[.)]) /.test(first) ||
    /^(?: {4}| {0,3}\t)/.test(first);
}

function setextLevel(t, pos, end) {
  let p = pos;
  const r = skipSpace(t, p, end, 0, 3);
  p = r[0];
  if (p >= end) return 0;
  const c = t.charCodeAt(p);
  if (c !== 61 && c !== 45) return 0;
  let count = 0;
  while (p < end && t.charCodeAt(p) === c) { p++; count++; }
  while (p < end) {
    const cc = t.charCodeAt(p);
    if (cc !== 32 && cc !== 9) return 0;
    p++;
  }
  return c === 61 ? 1 : 2;
}

function tryAtx(t, pos, end) {
  let p = pos;
  const r = skipSpace(t, p, end, 0, 3);
  p = r[0];
  if (p >= end || t.charCodeAt(p) !== 35) return null;
  let level = 0;
  while (p < end && t.charCodeAt(p) === 35 && level < 7) { p++; level++; }
  if (level > 6) return null;
  if (p < end) {
    const c = t.charCodeAt(p);
    if (c !== 32 && c !== 9) return null;
  }
  let content = t.slice(p);
  // strip leading whitespace
  content = content.replace(/^[ \t]+/, '');
  // strip trailing whitespace and closing #s
  content = content.replace(/[ \t]+$/, '');
  let m = /(^| )[ \t]*#+$/.exec(content);
  if (m) {
    content = content.slice(0, m.index);
    content = content.replace(/[ \t]+$/, '');
  }
  return [level, content];
}

function tryFence(t, pos, end) {
  let p = pos;
  const r = skipSpace(t, p, end, 0, 3);
  p = r[0];
  if (p >= end) return null;
  const c = t.charCodeAt(p);
  if (c !== 96 && c !== 126) return null;
  let len = 0;
  while (p < end && t.charCodeAt(p) === c) { p++; len++; }
  if (len < 3) return null;
  let info = t.slice(p).trim();
  if (c === 96 && info.indexOf('`') >= 0) return null;
  return [c, len, r[1], info];
}

function isThematic(t, pos, end) {
  let p = pos;
  const r = skipSpace(t, p, end, 0, 3);
  p = r[0];
  if (p >= end) return false;
  const c = t.charCodeAt(p);
  if (c !== 45 && c !== 95 && c !== 42) return false;
  let count = 0;
  while (p < end) {
    const cc = t.charCodeAt(p);
    if (cc === c) { count++; p++; }
    else if (cc === 32 || cc === 9) p++;
    else return false;
  }
  return count >= 3;
}

// can a block of kind interrupt a paragraph at this position?
function canInterrupt(text, p, n, kind) {
  if (kind === 'quote') return true;
  return true;
}

// ---------- finalize + render are in later parts ----------
// ---------- render blocks ----------

function escapeHtml(s) {
  let out = '';
  let start = 0;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (i > start) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  if (start === 0) return s;
  out += s.slice(start);
  return out;
}

function escapeCode(s) {
  return escapeHtml(s);
}

function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
}

function renderBlocks(blocks, refs, loose, tight) {
  let out = '';
  for (const b of blocks) out += renderBlock(b, refs, loose, tight);
  return out;
}

function renderBlock(b, refs, loose, tight) {
  switch (b.type) {
    case 'para': {
      let L = b.lines;
      if (tight || (b.parent && b.parent.type === 'item')) {
        // marked's item text ends at its last line that holds anything: trailing
        // whitespace-only lines go, but spaces at the end of a line stay
        while (L.length > 1 && /^[ \t]*$/.test(L[L.length - 1])) L = L.slice(0, -1);
      }
      let src = L.join('\n');
      if (tight) return renderInline(src, refs, false);
      return '<p>' + renderInline(src, refs, false) + '</p>\n';
    }
    case 'heading':
      return '<h' + b.level + '>' + renderInline(b.content, refs, false) + '</h' + b.level + '>\n';
    case 'setext':
      return '<h' + (b.level === 1 ? 1 : 2) + '>' + renderInline(b.lines.join('\n').trim(), refs, false) + '</h' + (b.level === 1 ? 1 : 2) + '>\n';
    case 'hr':
      return '<hr>\n';
    case 'blockquote':
      return '<blockquote>\n' + renderBlocks(b.children || [], refs, loose, false) + '</blockquote>\n';
    case 'code': {
      const lines = b.lines;
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
      return '<pre><code>' + escapeCode(lines.join('\n') + (lines.length ? '\n' : '')) + '</code></pre>\n';
    }
    case 'fence': {
      const info = b.info || '';
      const lang = unescapeString(info.trim().split(/\s+/)[0] || '');
      const cls = lang ? ' class="language-' + lang + '"' : '';
      if (b.lines.length && b.lines[b.lines.length - 1] === '') b.lines.pop();
      const body = b.lines.length ? b.lines.join('\n') + '\n' : '';
      return '<pre><code' + cls + '>' + escapeCode(body) + '</code></pre>\n';
    }
    case 'html': {
      // an html block that ends its container's text has no line end after it
      const par = b.parent;
      const ch = par && par.children;
      const last = !!(ch && ch[ch.length - 1] === b && (par.type === 'item' || par.type === 'blockquote'));
      const endNL = b.endNL && !last;
      let s = '';
      const L = b.lines;
      if (L.length) {
        for (let i = 0; i < L.length; i++) {
          s += L[i].t + (i < L.length - 1 ? '\n' : (endNL ? '\n' : ''));
        }
      }
      return s;
    }
    case 'list':
      return renderList(b, refs);
    case 'item':
      return renderItem(b, refs);
    case 'table':
      return renderTable(b, refs);
  }
  return '';
}

function listIsLoose(list) {
  if (list.looseBySeparation) return true;
  const items = list.children || [];
  for (const item of items) {
    if (item.innerBlank) return true;
  }
  return false;
}

function endsWithBlankLine(b) {
  if (b.blankAfter) return true;
  if (b.type === 'list' || b.type === 'item') {
    const ch = b.children;
    if (ch && ch.length) return endsWithBlankLine(ch[ch.length - 1]);
    return false;
  }
  return false;
}

// marked trims the last item's text end (list(): lastItem.text.trimEnd())
function trimItemTail(b) {
  const ch = b.children;
  if (ch && ch.length) { trimItemTail(ch[ch.length - 1]); return; }
  const L = b.lines;
  if (!L || !L.length) return;
  const last = L[L.length - 1];
  if (typeof last === 'string') L[L.length - 1] = last.replace(/[ \t]+$/, '');
  else last.t = last.t.replace(/[ \t]+$/, '');
}

function renderList(list, refs) {
  const loose = listIsLoose(list);
  const tag = list.ordered ? 'ol' : 'ul';
  let out = '<' + tag;
  if (list.ordered && list.start !== 1) out += ' start="' + list.start + '"';
  out += '>\n';
  const kids = list.children || [];
  let lastItemB = null;
  for (const item of kids) if (item.type === 'item') lastItemB = item;
  if (lastItemB) trimItemTail(lastItemB);
  for (const item of kids) {
    if (item.type !== 'item') continue;
    out += renderItem(item, refs, loose);
  }
  return out + '</' + tag + '>\n';
}

function renderItem(item, refs, loose) {
  if (loose === undefined) loose = false;
  const children = item.children || [];
  let body = '';
  let task = null;
  const first = children[0];
  if (first && first.type === 'para' && first.lines.length) {
    task = taskMatch(first.lines[0]);
  }
  if (loose) {
    body = '<li>';
    let k = 0;
    for (const ch of children) {
      if (k === 0 && task !== null && ch.type === 'para') {
        const inp = task > 0 ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">';
        const rest = task !== null ? ch.lines[0].slice(Math.abs(task)) : ch.lines[0];
        body += '<p>' + inp + ' ' + renderInline([rest].concat(ch.lines.slice(1)).join('\n'), refs, false) + '</p>\n';
      } else {
        body += renderBlock(ch, refs, loose, false);
      }
      k++;
    }
    return body + '</li>\n';
  }
  body = '<li>';
  let k = 0;
  for (const ch of children) {
    if (k === 0 && task !== null && ch.type === 'para') {
      const inp = task > 0 ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">';
      const rest = task !== null ? ch.lines[0].slice(Math.abs(task)) : ch.lines[0];
      body += inp + ' ' + renderInline([rest].concat(ch.lines.slice(1)).join('\n'), refs, false);
    } else {
      body += renderBlock(ch, refs, loose, true);
    }
    k++;
  }
  return body + '</li>\n';
}

function taskMatch(line) {
  // marked's listReplaceTask takes "[x]" and every space or tab after it, and a
  // task needs a non-space after that: "[x]  n" keeps only "n"
  if (line.length < 5 || line.charCodeAt(0) !== 91 || line.charCodeAt(2) !== 93) return null;
  const c = line.charCodeAt(1);
  if (c !== 32 && c !== 120 && c !== 88) return null;
  if (line.charCodeAt(3) !== 32 && line.charCodeAt(3) !== 9) return null;
  let i = 3;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  if (i >= line.length) return null;
  return c === 32 ? -i : i;
}

function renderTable(t, refs) {
  const align = t.align || [];
  let out = '<table>\n<thead>\n<tr>\n';
  for (let i = 0; i < t.header.length; i++) {
    out += '<th' + alignAttr(align[i]) + '>' + renderInline(t.header[i], refs, false) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  const rows = t.lines;
  if (rows && rows.length) {
    out += '<tbody>';
    for (const rowLine of rows) {
      const cells = splitRow(rowLine, t.header.length);
      out += '<tr>\n';
      for (let i = 0; i < t.header.length; i++) {
        const cell = i < cells.length ? cells[i] : '';
        out += '<td' + alignAttr(align[i]) + '>' + renderInline(cell, refs, false) + '</td>\n';
      }
      out += '</tr>\n';
    }
    out += '</tbody>';
  }
  return out + '</table>\n';
}

function alignAttr(a) {
  if (a === 1) return ' align="left"';
  if (a === 2) return ' align="center"';
  if (a === 3) return ' align="right"';
  return '';
}

// ---------- tables ----------

// split a row into cells; pipes inside code spans or escaped don't split
function splitRowAny(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  let inCode = false;
  let ticks = 0;
  let first = true;
  let lastPipe = false;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (inCode) {
      if (c === 96) {
        let j = i;
        while (j < n && line.charCodeAt(j) === 96) j++;
        const len = j - i;
        if (len === ticks) { inCode = false; ticks = 0; }
        cur += line.slice(i, j);
        i = j;
        continue;
      }
      cur += line[i];
      i++;
      continue;
    }
    if (c === 92 && i + 1 < n && (line.charCodeAt(i + 1) === 124 || line.charCodeAt(i + 1) === 92)) {
      cur += line.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === 124) { // |
      cells.push(cur);
      cur = '';
      lastPipe = true;
      i++;
      continue;
    }
    lastPipe = false;
    if (c === 96) {
      let j = i;
      while (j < n && line.charCodeAt(j) === 96) j++;
      const len0 = j - i;
      // only a code span whose closing run exists keeps pipes inside
      let k = j, found = -1;
      while (k < n && line.charCodeAt(k) !== 124) {
        if (line.charCodeAt(k) === 96) {
          let m = k;
          while (m < n && line.charCodeAt(m) === 96) m++;
          if (m - k === len0) { found = k; break; }
          k = m;
        } else k++;
      }
      if (found >= 0) {
        ticks = len0;
        inCode = true;
      }
      cur += line.slice(i, j);
      i = j;
      continue;
    }
    cur += line[i];
    i++;
  }
  cells.push(cur);
  return cells;
}

function cleanCell(s) {
  // trim, then replace escaped pipes with pipes
  return s.trim().replace(/\\\|/g, '|').replace(/\\\\/g, '\\');
}

function splitRow(line, cols) {
  let cells = splitRowAny(line);
  // drop leading empty when the row starts with an optional indent then a pipe
  let q = 0;
  while (q < line.length && line.charCodeAt(q) === 32) q++;
  if (line.length > 0 && line.charCodeAt(q) === 124) cells.shift();
  // drop trailing empty when line ends with |
  if (cells.length > 0 && line.length > 0 && line.charCodeAt(line.length - 1) === 124) cells.pop();
  cells = cells.map(cleanCell);
  return cells;
}

function delimRow(t, pos, end) {
  // marked's delimiter row: up to 3 spaces, an optional leading pipe, then
  // cells of :?-+:? separated by pipes with spaces, an optional trailing pipe
  const line = t.slice(pos, end);
  let i = 0;
  let lead = 0;
  while (i < line.length && lead < 4 && line.charCodeAt(i) === 32) { i++; lead++; }
  if (lead > 3) return null;
  let j = line.length;
  while (j > i && (line.charCodeAt(j - 1) === 32)) j--;
  let body = line.slice(i, j);
  if (body.indexOf('|') < 0 && body.indexOf(':') < 0) return null;
  if (/[^ |:\-]/.test(body)) return null;
  if (body.charCodeAt(0) === 124) body = body.slice(1);
  if (body.length && body.charCodeAt(body.length - 1) === 124) body = body.slice(0, -1);
  const parts = body.split('|');
  const align = [];
  for (let c of parts) {
    c = c.trim();
    if (!/^:?-+:?$/.test(c)) return null;
    const l = c.charCodeAt(0) === 58;
    const r = c.charCodeAt(c.length - 1) === 58;
    align.push(l && r ? 2 : l ? 1 : r ? 3 : 0);
  }
  if (!align.length) return null;
  return align;
}

function tryTableStart(t, pos, end, li, lines, interrupt) {
  const line = t.slice(pos, end);
  if (line.length === 0) return null;
  const next = lines[li + 1];
  if (!next) return null;
  const align = delimRow(next.t, 0, next.t.length);
  if (!align) return null;
  const cells = splitRowAny(line);
  {
    let q = 0;
    while (q < line.length && line.charCodeAt(q) === 32) q++;
    if (line.charCodeAt(q) === 124) cells.shift();
    if (cells.length && line.charCodeAt(line.length - 1) === 124) cells.pop();
  }
  if (cells.length !== align.length) return null;
  const header = cells.map((c) => c.trim().replace(/\\\|/g, '|').replace(/\\\\/g, '\\'));
  return [header, align];
}

// a line that continues a table body: any non-blank line that does not start
// another block construct, as marked's table body lookahead lists them
function isTableRow(t, pos, end, lines, li) {
  // marked's table body ends at a line of spaces only (a tab line is a row)
  let sp = pos;
  while (sp < end && t.charCodeAt(sp) === 32) sp++;
  if (sp >= end) return false;
  const lead = indentCols(t, pos, end, 0);
  const leadChars = lead[0] - pos;
  const p = pos + leadChars;
  // indented code needs something after the indent: a tab-only line is a row
  if (lead[1] >= 4 && p < end) return false;
  const c = t.charCodeAt(p);
  if (c === 62) return false; // block quote
  if (c === 35) { // #{1,6} then a space or the line end
    let k = p, n = 0;
    while (k < end && t.charCodeAt(k) === 35 && n < 8) { k++; n++; }
    if (n <= 6 && (k >= end || t.charCodeAt(k) === 32 || t.charCodeAt(k) === 9)) return false;
  }
  if (c === 96 || c === 126) {
    if (tryFence(t, p, end)) return false;
  }
  if (c === 60) {
    if (tryHtmlStart(t, p, end, false)) return false;
  }
  if (c === 45 || c === 43 || c === 42) {
    const nx = p + 1 < end ? t.charCodeAt(p + 1) : 32;
    if (nx === 32 || nx === 9) return false; // list item
    if (isThematic(t, p, end)) return false; // thematic break
  }
  if (c === 49 && p + 1 < end && (t.charCodeAt(p + 1) === 46 || t.charCodeAt(p + 1) === 41)) {
    const nx = p + 2 < end ? t.charCodeAt(p + 2) : 32;
    if (nx === 32 || nx === 9) return false; // `1.` / `1)` ordered item
  }
  return true;
}

// ---------- lists ----------

function tryListItem(text, p, n, c, stack, container, interrupt, refs, lines, li, matchedDepth) {
  // parse marker (after 0-3 indent)
  let i = p;
  let col = c;
  const r0 = skipSpace(text, i, n, col, 3);
  i = r0[0]; col = r0[1];
  const markerStartCol = col;
  let marker = 0;
  let ordered = false;
  let start = 0;
  const ch = text.charCodeAt(i);
  if (ch === 45 || ch === 43 || ch === 42) { marker = ch; i++; ordered = false; col++; }
  else if (ch >= 48 && ch <= 57) {
    let j = i;
    let num = 0;
    let digits = 0;
    while (j < n && text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57) { num = num * 10 + (text.charCodeAt(j) - 48); j++; digits++; }
    const dc = text.charCodeAt(j);
    if (digits <= 9 && (dc === 46 || dc === 41)) { ordered = true; marker = dc; start = num; col += (j - i) + 1; i = j + 1; }
    else return null;
  } else return null;

  if (i < n) {
    const cc = text.charCodeAt(i);
    if (cc !== 32 && cc !== 9) return null;
  }

  const itemStartCol = markerStartCol;

  // interrupt rules when paragraph is tip
  if (interrupt) {
    let blankItem = true;
    let j = i;
    while (j < n) {
      const cc = text.charCodeAt(j);
      if (cc !== 32 && cc !== 9) { blankItem = false; break; }
      j++;
    }
    if (blankItem) return null;
    if (ordered && start !== 1) {
      let inList = false;
      for (const b of stack) if (b.type === 'item') { inList = true; break; }
      if (!inList) return null;
    }
  }

  // find home list (sibling) or home container (new list)
  let b = stack[stack.length - 1];
  let home = null;
  let homeList = null;
  while (b) {
    if (b.type === 'item') {
      if (b.contentIndentAbs > itemStartCol || b.depth > matchedDepth) { b = b.parent; continue; }
      home = b; // marker within item content: nested list
      break;
    }
    if (b.type === 'list') {
      if (listMatches(b, ordered, marker) && b.depth <= matchedDepth) { homeList = b; home = b; break; }
      b = b.parent;
      continue;
    }
    if (b.type === 'para' || b.type === 'code' || b.type === 'fence' || b.type === 'html' || b.type === 'table') { b = b.parent; continue; }
    home = b;
    break;
  }
  home = homeList || home || b;
  if (!home) home = container;

  closeUnmatched(stack, home);

  const tip = stack[stack.length - 1];
  if (tip && tip.type === 'para') {
    tip.open = false;
    stack.pop();
  }

  let list;
  if (homeList) {
    list = homeList;
  } else {
    list = addChild(home, newBlock('list', home));
    list.ordered = ordered;
    list.marker = marker;
    list.delim = marker;
    list.start = start;
    list.indent = markerStartCol;
    stack.push(list);
  }

  // the first line's content, computed the way marked's list() does it: the
  // whitespace run after the marker is expanded against the marker's own width,
  // and a run longer than four columns keeps only one column of indent
  const bulletIndent = col - c;
  let wsEnd = i;
  while (wsEnd < n) {
    const cc = text.charCodeAt(wsEnd);
    if (cc !== 32 && cc !== 9) break;
    wsEnd++;
  }
  const blankItem = wsEnd >= n;
  let indent2;
  let firstContent = '';
  if (blankItem) {
    indent2 = 1;
  } else {
    let base = bulletIndent;
    let out = '';
    for (let k = i; k < wsEnd; k++) {
      if (text.charCodeAt(k) === 9) {
        const w = 4 - (base & 3);
        out += ' '.repeat(w);
        base += w;
      } else {
        out += ' ';
        base++;
      }
    }
    indent2 = out.length > 4 ? 1 : out.length;
    firstContent = out.slice(indent2) + text.slice(wsEnd);
  }

  const contentIndent = col + indent2;
  const item = addChild(list, newBlock('item', list));
  item.contentIndent = contentIndent - c;
  item.contentIndentAbs = contentIndent;
  stack.push(item);

  if (blankItem) return [wsEnd, col, false, null, n];
  return [0, contentIndent, true, firstContent, firstContent.length];
}

function listMatches(list, ordered, marker) {
  if (!list) return false;
  if (list.ordered !== ordered) return false;
  if (list.marker !== marker) return false;
  return true;
}

// ---------- html blocks ----------

function tryHtmlStart(t, pos, end, interrupt) {
  let p = pos;
  const r = skipSpace(t, p, end, 0, 3);
  p = r[0];
  if (p >= end || t.charCodeAt(p) !== 60) return null; // <
  const lower = t.toLowerCase();
  // kind 1
  for (const tag of ['script', 'pre', 'style', 'textarea']) {
    if (lower.startsWith('<' + tag, p)) {
      const after = p + tag.length + 1;
      if (after >= end) { return [1, 2, tag]; }
      const cc = t.charCodeAt(after);
      if (cc === 32 || cc === 9 || cc === 62) return [1, 2, tag];
    }
  }
  // kind 6: name prefix (open or close) alone is enough
  {
    let q = p + 1;
    let closing = false;
    if (q < end && t.charCodeAt(q) === 47) { closing = true; q++; }
    const nameStart = q;
    while (q < end) {
      const c = t.charCodeAt(q);
      if (c === 45 || c === 46 || c === 58 || (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) q++;
      else break;
    }
    if (q > nameStart) {
      const name = t.slice(nameStart, q);
      if (BLOCK_TAGS.has(name)) return [6, 6, name];
    }
  }
  if (t.startsWith('<!--', p)) return [2, 2, null];
  if (t.startsWith('<?', p)) return [3, 2, null];
  if (t.startsWith('<![CDATA[', p)) return [5, 2, null];
  if (t.charCodeAt(p + 1) === 33 && p + 2 < end) {
    const c2 = t.charCodeAt(p + 2);
    if (c2 >= 65 && c2 <= 90 || c2 >= 97 && c2 <= 122) return [4, 2, null];
  }
  // kind 7: complete tag alone on line
  const tagRes = parseTagOnly(t, p, end);
  if (tagRes) {
    const name = tagRes.toLowerCase();
    if (!interrupt) return [7, 7, name];
  }
  return null;
}

function scanHtmlEnd(lineText, kind) {
  switch (kind) {
    case 1: {
      const low = lineText.toLowerCase();
      if (low.indexOf('</script>') >= 0 || low.indexOf('</pre>') >= 0 ||
          low.indexOf('</style>') >= 0 || low.indexOf('</textarea>') >= 0) return true;
      return false;
    }
    case 2: return lineText.indexOf('-->') >= 0;
    case 3: return lineText.indexOf('?>') >= 0;
    case 4: return lineText.indexOf('>') >= 0;
    case 5: return lineText.indexOf(']]>') >= 0;
  }
  return false;
}

// complete open/close tag alone on a line (followed only by whitespace)
function parseTagOnly(t, pos, end) {
  const r = scanTag(t, pos, end);
  if (!r) return null;
  let p = r[1];
  while (p < end) {
    const c = t.charCodeAt(p);
    if (c !== 32 && c !== 9) return null;
    p++;
  }
  return r[0];
}

// whitespace inside a tag (may span lines)
function isTagWs(c) { return c === 32 || c === 9 || c === 10 || c === 13 || c === 12; }

// scans a complete open/close tag at pos; returns [tagName, endPos] or null
function scanTag(t, pos, end) {
  let i = pos;
  if (t.charCodeAt(i) !== 60) return null; // <
  i++;
  const closing = t.charCodeAt(i) === 47;
  if (closing) i++;
  if (i >= end || !isAlpha(t.charCodeAt(i))) return null;
  const nameStart = i;
  i++;
  while (i < end) {
    const c = t.charCodeAt(i);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45) i++;
    else break;
  }
  const name = t.slice(nameStart, i);
  if (closing) {
    if (i < end && !isTagWs(t.charCodeAt(i)) && t.charCodeAt(i) !== 62) return null;
    while (i < end && isTagWs(t.charCodeAt(i))) i++;
    if (i < end && t.charCodeAt(i) === 62) return [name, i + 1];
    return null;
  }
  while (true) {
    let j = i;
    while (j < end && isTagWs(t.charCodeAt(j))) j++;
    if (j >= end) return null;
    if (t.charCodeAt(j) === 62) return [name, j + 1];
    if (t.charCodeAt(j) === 47 && j + 1 < end && t.charCodeAt(j + 1) === 62) return [name, j + 2];
    if (j === i) return null; // attributes must be separated by whitespace
    const c0 = t.charCodeAt(j);
    if (!isAlpha(c0) && c0 !== 95 && c0 !== 58) return null;
    j++;
    while (j < end) {
      const c = t.charCodeAt(j);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
          c === 45 || c === 46 || c === 58 || c === 95) j++;
      else break;
    }
    i = j;
    let k = i;
    while (k < end && isTagWs(t.charCodeAt(k))) k++;
    if (k < end && t.charCodeAt(k) === 61) {
      k++;
      while (k < end && isTagWs(t.charCodeAt(k))) k++;
      if (k >= end) return null;
      const q = t.charCodeAt(k);
      if (q === 34 || q === 39) {
        k++;
        while (k < end && t.charCodeAt(k) !== q) k++;
        if (k >= end) return null;
        k++;
        i = k;
      } else {
        const vs = k;
        while (k < end) {
          const c = t.charCodeAt(k);
          if (c === 34 || c === 39 || c === 61 || c === 60 || c === 62 || c === 96 || isTagWs(c)) break;
          k++;
        }
        if (k === vs) return null;
        i = k;
      }
    }
  }
}

function isAlpha(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isSpaceOrTabC(c) { return c === 32 || c === 9; }

// ---------- inline parsing ----------

const NAMED_ENTITY_RE = /&([a-zA-Z][a-zA-Z0-9]{1,31});/;

function decodeNumericEntity(s, pos) {
  // s[pos] === '&'; try numeric forms; returns decoded char or null
  const n = s.length;
  let i = pos + 1;
  if (i >= n) return null;
  const c = s.charCodeAt(i);
  if (c === 35) { // #
    i++;
    if (i < n && (s.charCodeAt(i) === 120 || s.charCodeAt(i) === 88)) { // x
      i++;
      let digits = 0;
      let val = 0;
      while (i < n && digits < 7) {
        const d = s.charCodeAt(i);
        let hv;
        if (d >= 48 && d <= 57) hv = d - 48;
        else if (d >= 97 && d <= 102) hv = d - 87;
        else if (d >= 65 && d <= 70) hv = d - 55;
        else break;
        val = val * 16 + hv;
        digits++;
        i++;
      }
      if (digits >= 1 && digits <= 6 && i < n && s.charCodeAt(i) === 59) {
        return [String.fromCodePoint(val === 0 || val > 0x10ffff || (val >= 0xd800 && val <= 0xdfff) ? 0xfffd : val), i + 1];
      }
      return null;
    }
    let digits = 0;
    let val = 0;
    while (i < n && digits < 8) {
      const d = s.charCodeAt(i);
      if (d < 48 || d > 57) break;
      val = val * 10 + (d - 48);
      digits++;
      i++;
    }
    if (digits >= 1 && digits <= 7 && i < n && s.charCodeAt(i) === 59) {
      return [String.fromCodePoint(val === 0 || val > 0x10ffff || (val >= 0xd800 && val <= 0xdfff) ? 0xfffd : val), i + 1];
    }
    return null;
  }
  return null;
}

function tryNamedEntity(s, pos) {
  const n = s.length;
  let i = pos + 1;
  if (i >= n || !isAlpha(s.charCodeAt(i))) return null;
  let start = i;
  i++;
  while (i < n && (isAlpha(s.charCodeAt(i)) || (s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57))) i++;
  const len = i - start;
  if (len < 1 || len > 32) return null;
  if (i < n && s.charCodeAt(i) === 59) return [s.slice(pos, i + 1), i + 1];
  return null;
}

function tryAutolink(s, pos) {
  // <scheme:...> or <user@host>
  const n = s.length;
  let i = pos + 1;
  if (i >= n || !isAlpha(s.charCodeAt(i))) return null;
  let j = i;
  while (j < n && (isAlpha(s.charCodeAt(j)) || s.charCodeAt(j) === 43 || s.charCodeAt(j) === 45 || s.charCodeAt(j) === 46)) j++;
  const schemeLen = j - i;
  if (schemeLen < 2 || schemeLen > 32) return null;
  if (j < n && s.charCodeAt(j) === 58) { // :
    let k = j + 1;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c <= 32 || c === 60 || c === 62) break;
      k++;
    }
    if (k >= n || s.charCodeAt(k) !== 62) return null;
    const uri = s.slice(i, k);
    return [k + 1, uri, uri];
  }
  // email autolink
  const e = pos + 1;
  const em = scanEmailAutolink(s, e);
  if (em && s.charCodeAt(em[1]) === 62) return [em[1] + 1, em[0], 'mailto:' + em[0]];
  return null;
}

function scanEmailAutolink(s, pos) {
  const n = s.length;
  let i = pos;
  while (i < n) {
    const c = s.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
        c === 46 || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  if (i === pos) return null;
  if (s.charCodeAt(i) !== 64) return null; // @
  i++;
  while (i < n) {
    const c = s.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 95 || c === 46) i++;
    else break;
  }
  return [s.slice(pos, i), i];
}

// tokenizer: scan src into tokens; delimiters + brackets tracked
const IRU = {
  escape: new RegExp("^\\\\([!\"#$%&'()*+,\\-./:;<=>?@\\[\\]\\\\^_`{|}~])", ""),
  tag: new RegExp("^<!--(?:-?>|[\\s\\S]*?-->)|^<\\/[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*\"[^\"]*\"|\\s*=\\s*'[^']*'|\\s*=\\s*[^\\s\"'=<>`]+)?)*?\\s*\\/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>", ""),
  link: new RegExp("^!?\\[((?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?)\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\])*'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)", ""),
  reflink: new RegExp("^!?\\[((?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?)\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\]", ""),
  nolink: new RegExp("^!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\](?:\\[\\])?", ""),
  emStrongLDelim: new RegExp("^(?:\\*+(?:((?!\\*)(?!~)[\\p{P}\\p{S}])|([^\\s*]))?)|^_+(?:((?!_)(?!~)[\\p{P}\\p{S}])|([^\\s_]))?", "u"),
  emStrongRDelimAst: new RegExp("^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?=[\\s]|$)|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?!\\*)(?=(?!~)[\\s\\p{P}\\p{S}]|$)|(?!\\*)(?!~)[\\s\\p{P}\\p{S}](\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))|[\\s](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))", "gu"),
  emStrongRDelimUnd: new RegExp("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)[\\p{P}\\p{S}](_+)(?=[\\s]|$)|[^\\s\\p{P}\\p{S}](_+)(?!_)(?=[\\s\\p{P}\\p{S}]|$)|(?!_)[\\s\\p{P}\\p{S}](_+)(?=[^\\s\\p{P}\\p{S}])|[\\s](_+)(?!_)(?=[\\p{P}\\p{S}])|(?!_)[\\p{P}\\p{S}](_+)(?!_)(?=[\\p{P}\\p{S}])", "gu"),
  del: new RegExp("^(~~?)(?=[^\\s~])((?:\\\\[\\s\\S]|[^\\\\])*?(?:\\\\[\\s\\S]|[^\\s~\\\\]))\\1(?=[^~]|$)", ""),
  delLDelim: new RegExp("^~~?(?:((?!~)[\\p{P}\\p{S}])|[^\\s~])", "u"),
  delRDelim: new RegExp("^[^~]+(?=[^~])|(?!~)[\\p{P}\\p{S}](~~?)(?=[\\s]|$)|[^\\s\\p{P}\\p{S}](~~?)(?!~)(?=[\\s\\p{P}\\p{S}]|$)|(?!~)[\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])|[\\s](~~?)(?!~)(?=[\\p{P}\\p{S}])|(?!~)[\\p{P}\\p{S}](~~?)(?!~)(?=[\\p{P}\\p{S}])|[^\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])", "gu"),
  code: new RegExp("^(`+)([^`]|[^`][\\s\\S]*?[^`])\\1(?!`)", ""),
  br: new RegExp("^( {2,}|\\\\)\\n(?!\\s*$)[ \\t]*", ""),
  autolink: new RegExp("^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\\s\\x00-\\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>", ""),
  url: new RegExp("^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])(?:\\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])", ""),
  text: new RegExp("^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\\n)|(?=[a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-]+@)|[\\s\\S]*?(?:(?=[\\\\<!\\[`*~_]|\\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\\/\\/|(?<![^\\s*_~(])www\\.|$)|[^ ](?= {2,}\\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-](?=[a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-]+@))))", ""),
  punctuation: new RegExp("^((?![*_])[\\s\\p{P}\\p{S}])", "u"),
  anyPunctuation: new RegExp("\\\\([\\p{P}\\p{S}])", "gu"),
  anyPunctuationOutsideCode: new RegExp("(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\([\\p{P}\\p{S}])", "gu"),
  blockSkip: new RegExp("\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)|<(?! )[^<>]*?>", "g"),
  reflinkSearch: new RegExp("!?\\[((?:[^\\[\\]\\\\`]*(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?)\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\]|!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\](?:\\[\\])?(?!\\()", "g"),
  _backpedal: new RegExp("(?:[^?!.,:;*_'\"~()&]+|\\([^)]*\\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+", ""),
};
const IRO = {
  outputLinkReplace: new RegExp("\\\\([\\[\\]])", "g"),
  startAngleBracket: new RegExp("^<", ""),
  endAngleBracket: new RegExp(">$", ""),
  newLineCharGlobal: new RegExp("\\n", "g"),
  nonSpaceChar: new RegExp("[^ ]", ""),
  startingSpaceChar: new RegExp("^ ", ""),
  endingSpaceChar: new RegExp(" $", ""),
  unicodeAlphaNumeric: new RegExp("[\\p{L}\\p{N}]", "u"),
  numericCharacterReference: new RegExp("&#(?:(\\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));", ""),
  numericCharacterReferenceOrAmpersand: new RegExp("&#(?:(\\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\\w+);)", "g"),
  escapeTest: new RegExp("[&<>\"']", ""),
  escapeTestNoEncode: new RegExp("[<>\"']|&(?!(#\\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\\w+);)", ""),
  escapeReplace: new RegExp("[&<>\"']", "g"),
  escapeReplaceNoEncode: new RegExp("[<>\"']|&(?!(#\\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\\w+);)", "g"),
  percentDecode: new RegExp("%25", "g"),
  startATag: new RegExp("^<a ", "i"),
  endATag: new RegExp("^<\\/a>", "i"),
  startPreScriptTag: new RegExp("^<(pre|code|kbd|script)(\\s|>)", "i"),
  endPreScriptTag: new RegExp("^<\\/(pre|code|kbd|script)(\\s|>)", "i"),
  multipleSpaceGlobal: new RegExp("\\s+", "g"),
  carriageReturn: new RegExp("\\r\\n|\\r", "g"),
};

// ---------- inline layer: marked 18.1.3's inline tokenizer, carried over ----------

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escRepl(c) { return ESC_MAP[c]; }
function escapeEntities(s, encode) {
  if (encode) {
    if (IRO.escapeTest.test(s)) return s.replace(IRO.escapeReplace, escRepl);
  } else {
    if (IRO.escapeTestNoEncode.test(s)) return s.replace(IRO.escapeReplaceNoEncode, escRepl);
  }
  return s;
}

function decodeNumericRefs(s) {
  if (!IRO.numericCharacterReference.test(s)) return s;
  return s.replace(IRO.numericCharacterReferenceOrAmpersand, (m0, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

function rtrimChar(str, c) {
  let l = str.length;
  while (l > 0 && str.charAt(l - 1) === c) l--;
  return str.slice(0, l);
}

// marked's findClosingBracket(str, '()')
function findCloseParen(str) {
  if (str.indexOf('(') === -1 && str.indexOf(')') === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\\') i++;
    else if (ch === '(') level++;
    else if (ch === ')') {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

function encodeUrlAttr(href) {
  try {
    return encodeURI(href).replace(IRO.percentDecode, '%');
  } catch (e) {
    return null;
  }
}

function refOf(refs, label) {
  if (!refs) return null;
  if (label.length > 999) return null;
  return refs.get(normLabel(label)) || null;
}

function hasRefLabel(refs, label) {
  if (!refs) return false;
  return refs.has(normLabel(label));
}

// Mask links, code, html and escapes so emStrong and del do not see their delimiters inside them.
function maskInlineSource(src, refs) {
  let masked = src;
  if (refs && refs.size > 0 && src.indexOf('[') >= 0) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!hasRefLabel(refs, match0.slice(refStart + 1, -1))) return match0;
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(text, refs)) {
          return '[' + text.replace(IRU.reflinkSearch, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    masked = masked.replace(IRU.reflinkSearch, maskReflink);
  }
  masked = masked.replace(IRU.anyPunctuationOutsideCode, (match0, code, punct) => {
    if (punct) return '+'.repeat(match0.length);
    if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
    return match0;
  });
  masked = masked.replace(IRU.blockSkip, (match0, _link, context) => {
    const offset = context ? context.length : 0;
    return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
  });
  return masked;
}

function linkInText(text, refs) {
  if (text.indexOf('[') < 0) return false;
  for (const match of text.matchAll(IRU.blockSkip)) {
    if (IRU.link.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(IRU.reflinkSearch)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !hasRefLabel(refs, match0.slice(refStart + 1, -1))) continue;
    if (refStart > 1 && linkInText(match0.slice(1, refStart - 1), refs)) continue;
    return true;
  }
  return false;
}

function isLabelEndInsideToken(src, label, labelStart) {
  if (label.indexOf('<') < 0) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = IRU.code.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = IRU.tag.exec(tokenSrc) || IRU.autolink.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

function outputLink(cap, link, raw, refs, state) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(IRO.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = state.inLink;
  const outerLinkEmitted = state.linkEmitted;
  const outerInRawBlock = state.inRawBlock;
  state.inLink = true;
  state.linkEmitted = false;
  const children = inlineLex(text, refs, state);
  const textHasLink = state.linkEmitted;
  state.linkEmitted = outerLinkEmitted;
  state.inLink = outerInLink;
  if (!isImage) {
    // Links may not contain other links: bail so the inner link is the one kept.
    if (textHasLink) {
      state.inRawBlock = outerInRawBlock;
      return;
    }
    state.linkEmitted = true;
  }
  return { k: isImage ? 'image' : 'link', raw, href, title, text, children };
}

function inlineLex(src, refs, state) {
  const prevParen = state.linkParenPossible;
  state.linkParenPossible = prevParen && src.indexOf(')') >= 0;
  try {
    return inlineLexInner(src, refs, state);
  } finally {
    state.linkParenPossible = prevParen;
  }
}

function inlineLexInner(src, refs, state) {
  const maskedSrc = (src.indexOf('*') >= 0 || src.indexOf('_') >= 0 || src.indexOf('~') >= 0)
    ? maskInlineSource(src, refs)
    : src;
  const toks = [];
  let rest = src;
  let prevChar = '';
  let keepPrevChar = false;
  let lastLen = Infinity;
  while (rest.length > 0) {
    if (rest.length < lastLen) lastLen = rest.length;
    else break;
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;
    let cap, tok;

    if ((cap = IRU.escape.exec(rest))) {
      toks.push({ k: 'esc', s: cap[1], raw: cap[0] });
      rest = rest.slice(cap[0].length);
      continue;
    }

    if ((cap = IRU.tag.exec(rest))) {
      const raw = cap[0];
      if (!state.inLink && IRO.startATag.test(raw)) state.inLink = true;
      else if (state.inLink && IRO.endATag.test(raw)) state.inLink = false;
      if (!state.inRawBlock && IRO.startPreScriptTag.test(raw)) state.inRawBlock = true;
      else if (state.inRawBlock && IRO.endPreScriptTag.test(raw)) state.inRawBlock = false;
      toks.push({ k: 'html', s: raw, raw });
      rest = rest.slice(raw.length);
      continue;
    }

    if ((tok = lexLink(rest, refs, state))) {
      rest = rest.slice(tok.raw.length);
      toks.push(tok);
      continue;
    }

    if ((tok = lexReflink(rest, refs, state))) {
      rest = rest.slice(tok.raw.length);
      const last = toks[toks.length - 1];
      if (tok.k === 't' && last && last.k === 't') {
        last.s = last.s + tok.s;
        last.raw = last.raw + tok.raw;
      } else {
        toks.push(tok);
      }
      continue;
    }

    if ((tok = lexEmStrong(rest, maskedSrc, prevChar, refs, state))) {
      rest = rest.slice(tok.raw.length);
      toks.push(tok);
      continue;
    }

    if ((cap = IRU.code.exec(rest))) {
      let text = cap[2].replace(IRO.newLineCharGlobal, ' ');
      const hasNonSpaceChars = IRO.nonSpaceChar.test(text);
      const spaceBothEnds = IRO.startingSpaceChar.test(text) && IRO.endingSpaceChar.test(text);
      if (hasNonSpaceChars && spaceBothEnds) text = text.slice(1, -1);
      toks.push({ k: 'code', s: text, raw: cap[0] });
      rest = rest.slice(cap[0].length);
      continue;
    }

    if ((cap = IRU.br.exec(rest))) {
      toks.push({ k: 'br', raw: cap[0] });
      rest = rest.slice(cap[0].length);
      continue;
    }

    if ((tok = lexDel(rest, maskedSrc, prevChar, refs, state))) {
      rest = rest.slice(tok.raw.length);
      toks.push(tok);
      continue;
    }

    if ((cap = IRU.autolink.exec(rest))) {
      const isMail = cap[2] === '@';
      const href = isMail ? 'mailto:' + cap[1] : cap[1];
      toks.push({ k: 'link', raw: cap[0], href, title: null, text: cap[1], auto: true });
      rest = rest.slice(cap[0].length);
      continue;
    }

    if (!state.inLink && (tok = lexUrl(rest))) {
      rest = rest.slice(tok.raw.length);
      toks.push(tok);
      continue;
    }

    cap = IRU.text.exec(rest);
    if (!cap) {
      const ch = rest.charAt(0);
      toks.push({ k: 't', s: ch, raw: ch });
      rest = rest.slice(1);
      continue;
    }
    const raw = cap[0];
    const text = state.inRawBlock ? raw : decodeNumericRefs(raw);
    if (raw.length > 0 && raw.charAt(raw.length - 1) !== '_') prevChar = raw.charAt(raw.length - 1);
    keepPrevChar = true;
    const lastTok = toks[toks.length - 1];
    if (lastTok && lastTok.k === 't') {
      lastTok.s = lastTok.s + text;
      lastTok.raw = lastTok.raw + raw;
    } else {
      toks.push({ k: 't', s: text, raw, escaped: state.inRawBlock });
    }
    rest = rest.slice(raw.length);
  }
  return toks;
}

function lexLink(rest, refs, state) {
  if (state.linkParenPossible === false) return;
  const cap = IRU.link.exec(rest);
  if (!cap) return;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(rest, cap[1], labelStart)) return;
  const trimmedUrl = cap[2].trim();
  if (IRO.startAngleBracket.test(trimmedUrl)) {
    if (!IRO.endAngleBracket.test(trimmedUrl)) return;
    const cutSlash = rtrimChar(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - cutSlash.length) % 2 === 0) return;
  } else {
    const lastParenIndex = findCloseParen(cap[2]);
    if (lastParenIndex === -2) return;
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  const unescaped = rtrimChar(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return;
  let href = cap[2];
  let title = '';
  title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (IRO.startAngleBracket.test(href)) href = href.slice(1, -1);
  return outputLink(cap, {
    href: href ? href.replace(IRU.anyPunctuation, '$1') : href,
    title: title ? title.replace(IRU.anyPunctuation, '$1') : title,
  }, cap[0], refs, state);
}

function lexReflink(rest, refs, state) {
  let cap;
  if (!(cap = IRU.reflink.exec(rest)) && !(cap = IRU.nolink.exec(rest))) return;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(rest, cap[1], labelStart)) return;
  const link = refOf(refs, cap[2] || cap[1]);
  if (!link) {
    const ch = cap[0].charAt(0);
    return { k: 't', s: ch, raw: ch };
  }
  return outputLink(cap, link, cap[0], refs, state);
}

function lexEmStrong(rest, maskedSrc, prevChar, refs, state) {
  let match = IRU.emStrongLDelim.exec(rest);
  if (!match) return;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return;
  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;
  const srcStart = maskedSrc.length - rest.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  const runPrevChar = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!IRU.punctuation.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!IRU.punctuation.exec(prevChar);
  if (match[4] && prevChar.match(IRO.unicodeAlphaNumeric)) return;
  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim() && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return;
    const endReg = delimChar === '*' ? IRU.emStrongRDelimAst : IRU.emStrongRDelimUnd;
    const windowStart = srcStart + lLength;
    const win = maskedSrc.slice(windowStart);
    endReg.lastIndex = 0;
    while ((match = endReg.exec(win)) !== null) {
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = rest.slice(0, lLength + match.index + lastCharLength + rLength);
      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        return { k: 'em', raw, children: inlineLex(text, refs, state) };
      }
      const text = raw.slice(2, -2);
      return { k: 'strong', raw, children: inlineLex(text, refs, state) };
    }
  }
}

function lexDel(rest, maskedSrc, prevChar, refs, state) {
  let match = IRU.delLDelim.exec(rest);
  if (!match) return;
  if (!(match[1] || '') || !prevChar || IRU.punctuation.exec(prevChar)) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength;
    const windowStart = maskedSrc.length - rest.length + lLength;
    const win = maskedSrc.slice(windowStart);
    const endReg = IRU.delRDelim;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(win)) !== null) {
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = rest.slice(0, lLength + match.index + lastCharLength + rLength);
      const text = raw.slice(lLength, -lLength);
      return { k: 'del', raw, children: inlineLex(text, refs, state) };
    }
  }
}

function lexUrl(rest) {
  let cap = IRU.url.exec(rest);
  if (!cap) return;
  let text, href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    let prev;
    do {
      prev = cap[0];
      const bp = IRU._backpedal.exec(cap[0]);
      cap[0] = bp ? bp[0] : '';
    } while (prev !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  return { k: 'link', raw: cap[0], href, title: null, text, auto: true };
}

// ---------- inline rendering (marked 18.1.3's renderer) ----------

function renderInline(src, refs, inLink) {
  const state = INLINE_STATE || { inLink: false, linkEmitted: false, inRawBlock: false, linkParenPossible: true };
  state.inRawBlock = false;
  const toks = inlineLex(src, refs, state);
  return renderInlineToks(toks);
}

function renderInlineToks(toks) {
  let out = '';
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k === 't') { out += t.escaped ? t.s : escapeEntities(t.s, false); continue; }
    switch (t.k) {
      case 'esc': out += escapeEntities(t.s, false); break;
      case 'code': out += '<code>' + escapeEntities(t.s, true) + '</code>'; break;
      case 'html': out += t.s; break;
      case 'br': out += '<br>'; break;
      case 'em': out += '<em>' + renderInlineToks(t.children) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInlineToks(t.children) + '</strong>'; break;
      case 'del': out += '<del>' + renderInlineToks(t.children) + '</del>'; break;
      case 'link': {
        const body = t.auto ? escapeEntities(t.text, true) : renderInlineToks(t.children || []);
        const url = encodeUrlAttr(t.href);
        if (url === null) { out += body; break; }
        out += '<a href="' + escapeEntities(url, !!t.auto) + '"';
        if (t.title) out += ' title="' + escapeEntities(t.title, false) + '"';
        out += '>' + body + '</a>';
        break;
      }
      case 'image': {
        const alt = t.children ? renderAlt(t.children) : t.text;
        const url = encodeUrlAttr(t.href);
        if (url === null) { out += escapeEntities(alt, false); break; }
        out += '<img src="' + escapeEntities(url, false) + '" alt="' + escapeEntities(alt, false) + '"';
        if (t.title) out += ' title="' + escapeEntities(t.title, false) + '"';
        out += '>';
        break;
      }
    }
  }
  return out;
}

function scanComment(s, pos, n) {
  if (pos + 4 > n || s.charCodeAt(pos + 2) !== 45 || s.charCodeAt(pos + 3) !== 45) return null;
  // <!--> and <!---> are complete (empty) comments
  if (s.charCodeAt(pos + 4) === 62) return pos + 5;
  if (s.charCodeAt(pos + 4) === 45 && pos + 5 < n && s.charCodeAt(pos + 5) === 62) return pos + 6;
  const e = s.indexOf('-->', pos + 4);
  if (e < 0) return null;
  return e + 3;
}
function scanSpecialHtml(s, pos, n) {
  const c1 = s.charCodeAt(pos + 1);
  if (c1 === 63) { // ?
    const e = s.indexOf('?>', pos + 2);
    return e < 0 ? 0 : e + 2;
  }
  if (c1 === 33) { // !
    if (s.startsWith('<![CDATA[', pos)) {
      const e = s.indexOf(']]>', pos + 9);
      return e < 0 ? 0 : e + 3;
    }
    const c2 = s.charCodeAt(pos + 2);
    if (!(c2 >= 65 && c2 <= 90)) return 0;
    const e = s.indexOf('>', pos + 2);
    return e < 0 ? 0 : e + 1;
  }
  return 0;
}

// ---------- GFM extended autolinks ----------

function tryExtEmail(src, at, bufStart) {
  const n = src.length;
  // local part: scan back over [A-Za-z0-9._+-]
  let s = at;
  const lim = bufStart >= 0 ? bufStart : 0;
  while (s > lim) {
    const c = src.charCodeAt(s - 1);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
        c === 46 || c === 95 || c === 43 || c === 45) s--;
    else break;
  }
  if (s === at) return null;
  // the local part needs at least one letter or digit
  let alnum = false;
  for (let k = s; k < at; k++) {
    const c = src.charCodeAt(k);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)) { alnum = true; break; }
  }
  if (!alnum) return null;
  // domain
  let i = at + 1;
  const domStart = i;
  while (i < n) {
    const c = src.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 95 || c === 46) i++;
    else break;
  }
  const rawDom = src.slice(domStart, i);
  const dom = rawDom.replace(/[._-]+$/, '');
  if (rawDom.length > dom.length) {
    if (/[-_]/.test(rawDom.slice(dom.length)) && /^[ \t]*$/.test(src.slice(i))) return null;
    i = domStart + dom.length;
  }
  if (!validDomain(dom)) return null;
  const email = src.slice(s, i);
  if (i < n && src.charCodeAt(i) === 47) return null; // followed by /
  let e2 = i;
  while (e2 > s + 1 && isTrailingPunct(src.charCodeAt(e2 - 1))) e2--;
  if (!alnum) return null;
  return [src.slice(s, e2), e2, s];
}

// GFM extended autolink email starting exactly at pos
function tryExtEmailAt(src, pos, bufStart) {
  const n = src.length;
  let i = pos;
  const localStart = i;
  while (i < n) {
    const c = src.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
        c === 46 || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  if (i === localStart || i >= n || src.charCodeAt(i) !== 64) return null;
  const local = src.slice(localStart, i);
  if (!/[A-Za-z0-9]/.test(local)) return null;
  if (local.charCodeAt(local.length - 1) === 46) return null;
  i++;
  const domStart = i;
  while (i < n) {
    const c = src.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 95 || c === 46) i++;
    else break;
  }
  const rawDom = src.slice(domStart, i);
  const dom = rawDom.replace(/[._-]+$/, '');
  if (rawDom.length > dom.length) {
    if (/[-_]/.test(rawDom.slice(dom.length)) && /^[ \t]*$/.test(src.slice(i))) return null;
    i = domStart + dom.length;
  }
  if (!validDomain(dom)) return null;
  if (i < n && src.charCodeAt(i) === 47) return null; // followed by /
  let e2 = i;
  while (e2 > localStart + 1 && isTrailingPunct(src.charCodeAt(e2 - 1))) e2--;
  if (e2 <= localStart) return null;
  return [src.slice(localStart, e2), e2];
}

function tryExtUrl(src, i, bufStart, inBracket) {
  const n = src.length;
  // trigger check
  if (i > 0) {
    const prev = src.charCodeAt(i - 1);
    if (!isSpace(prev) && prev !== 42 && prev !== 95 && prev !== 126 && prev !== 40 && prev !== 60) return null;
  }
  let kind = null;
  let j = i;
  const head = src.slice(i, Math.min(n, i + 8)).toLowerCase();
  if (src.startsWith('www.', i)) { kind = 'www'; j = i + 4; }
  else if (head.startsWith('http://')) { kind = 'http'; j = i + 7; }
  else if (head.startsWith('https://')) { kind = 'https'; j = i + 8; }
  else if (head.startsWith('ftp://')) { kind = 'ftp'; j = i + 6; }
  else if (head.startsWith('mailto:')) { kind = 'mailto'; j = i + 7; }
  else if (head.startsWith('xmpp:')) { kind = 'xmpp'; j = i + 5; }
  if (!kind) return null;

  if (kind === 'mailto' || kind === 'xmpp') {
    const em = scanEmailAfter(src, j, n);
    if (!em) return null;
    let end = em[1];
    let text = src.slice(i, end);
    if (kind === 'xmpp' && end < n && src.charCodeAt(end) === 47) { // /node
      let k = end + 1;
      while (k < n) {
        const c = src.charCodeAt(k);
        if (c <= 32 || c === 60 || c === 62 || c === 47) break;
        k++;
      }
      if (k > end + 1) { end = k; text = src.slice(i, end); }
    }
    // trailing punctuation trim
    while (end > j && isTrailingPunct(src.charCodeAt(end - 1))) { end--; }
    if (end <= j) return null;
    text = src.slice(i, end);
    return [text, end, text];
  }

  // domain
  const domStart = j;
  while (j < n) {
    const c = src.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 95 || c === 46) j++;
    else break;
  }
  const rawDom = src.slice(domStart, j);
  const dom = rawDom.replace(/[._-]+$/, '');
  if (dom.length < rawDom.length) j = domStart + dom.length;
  if (!validDomain(dom)) return null;
  // path
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c <= 32 || c === 60) break;
    if (inBracket === 1 && c === 93) {
      let q = j + 1;
      if (q < n && src.charCodeAt(q) === 40) break;
    }

    j++;
  }
  let end = j;
  let text = src.slice(i, end);
  // entity trim: ends with ; and &...; present
  if (text.endsWith(';')) {
    const amp = text.lastIndexOf('&');
    if (amp >= 0 && /^&[a-zA-Z0-9]+;$/.test(text.slice(amp))) {
      text = text.slice(0, amp);
      end = i + text.length;
    }
  }
  // trim trailing punctuation and unbalanced closing parens until stable
  for (;;) {
    const before = end;
    while (end > domStart && isTrailingPunct(src.charCodeAt(end - 1))) end--;
    let parens = 0;
    for (let k = i; k < end; k++) {
      const c = src.charCodeAt(k);
      if (c === 40) parens++;
      else if (c === 41) parens--;
    }
    if (parens < 0 && end > domStart && src.charCodeAt(end - 1) === 41) { end--; continue; }
    if (end === before) break;
  }
  if (end <= i) return null;
  text = src.slice(i, end);
  const href = kind === 'www' ? 'http://' + text : text;
  return [text, end, href];
}

function validDomain(dom) {
  const d = dom.replace(/\.+$/, '');
  if (!d) return false;
  const segs = d.split('.');
  if (segs.length < 2) return false;
  for (const s of segs) if (!/^[A-Za-z0-9_-]+$/.test(s)) return false;
  const last = segs[segs.length - 1];
  return /[A-Za-z0-9]$/.test(last);
}

function scanEmailAfter(s, pos, n) {
  let i = pos;
  while (i < n) {
    const c = s.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
        c === 46 || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  if (i === pos) return null;
  if (s.charCodeAt(i) !== 64) return null;
  i++;
  const domStart = i;
  while (i < n) {
    const c = s.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 95 || c === 46) i++;
    else break;
  }
  const rawDom = s.slice(domStart, i);
  const dom = rawDom.replace(/[._-]+$/, '');
  if (rawDom.length > dom.length) {
    if (/[-_]/.test(rawDom.slice(dom.length)) && /^[ \t]*$/.test(s.slice(i))) return null;
    i = domStart + dom.length;
  }
  if (!validDomain(dom)) return null;
  return [s.slice(pos, i), i];
}

function isTrailingPunct(c) {
  return c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 95 || c === 126 || c === 42 || c === 39 || c === 59;
}

// ---------- inline link destination/title ----------

function parseInlineDest(src, pos, n) {
  let i = pos; // at '('
  i++;
  // skip whitespace incl newlines
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10) i++;
    else break;
  }
  let dest = null;
  if (i < n && src.charCodeAt(i) === 60) { // <...>
    let j = i + 1;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 62) break;
      if (c === 60) return null;
      if (c === 92 && j + 1 < n && isPunct(src.charCodeAt(j + 1))) { j += 2; continue; }
      if (c === 10) return null;
      j++;
    }
    if (j >= n) return null;
    dest = unescapeString(src.slice(i + 1, j));
    i = j + 1;
  } else if (i < n && !(src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9 || src.charCodeAt(i) === 10)) {
    let j = i;
    let depth = 0;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 92 && j + 1 < n && isPunct(src.charCodeAt(j + 1))) { j += 2; continue; }
      if (c <= 32) break;
      if (c === 40) { depth++; j++; continue; }
      if (c === 41) {
        if (depth === 0) break;
        depth--; j++; continue;
      }
      j++;
    }
    dest = unescapeString(src.slice(i, j));
    i = j;
  } else {
    dest = '';
  }
  // optional title
  let title = null;
  let j = i;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10) j++;
    else break;
  }
  if (j < n && j > i) {
    const q = src.charCodeAt(j);
    let closeQ = 0;
    if (q === 34) closeQ = 34;
    else if (q === 39) closeQ = 39;
    else if (q === 40) closeQ = 41;
    if (closeQ) {
      let k = j + 1;
      while (k < n) {
        const c = src.charCodeAt(k);
        if (c === 92 && k + 1 < n && isPunct(src.charCodeAt(k + 1))) { k += 2; continue; }
        if (c === closeQ) break;
        if (closeQ === 41 && c === 40) return null;
        k++;
      }
      if (k >= n) return null;
      title = unescapeString(src.slice(j + 1, k));
      j = k + 1;
    }
  }
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10) j++;
    else break;
  }
  if (j >= n || src.charCodeAt(j) !== 41) return null;
  return { href: cleanUrl(dest), title, consumedTo: j + 1 };
}

function unescapeString(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '';
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < n && isPunct(s.charCodeAt(i + 1))) { out += s[i + 1]; i++; }
    else out += s[i];
  }
  return out;
}

function findLabelEnd(src, pos, n) {
  // find unescaped ] with no unescaped [ before it
  let i = pos;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 92) { i += 2; continue; }
    if (c === 91) return -1;
    if (c === 93) return i;
    i++;
  }
  return -1;
}

function normLabel(s) {
  let k = s.replace(/[ \t\r\n\f\v]+/g, ' ').trim().toLowerCase();
  if (k.indexOf('\u00df') >= 0) k = k.replace(/\u00df/g, 'ss');
  return k;
}

function lookupRef(refs, label) {
  if (label.length > 999) return null;
  if (label.trim() === '') return null;
  const r = refs.get(normLabel(label));
  if (!r) return null;
  return { href: r.href, title: r.title };
}

// ---------- inline rendering ----------

function escapeAttr(s) {
  let out = '';
  let start = 0;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) {
      // skip if a valid entity form follows
      if (isEntityAt(s, i)) continue;
      rep = '&amp;';
    }
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (i > start) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  if (start === 0) return s;
  out += s.slice(start);
  return out;
}

function isEntityAt(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n) return false;
  const c = s.charCodeAt(j);
  if (c === 35) { // #
    j++;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) {
      j++;
      let d = 0;
      while (j < n && d < 6 && isHex(s.charCodeAt(j))) { j++; d++; }
      return d >= 1 && j < n && s.charCodeAt(j) === 59;
    }
    let d = 0;
    while (j < n && d < 7 && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) { j++; d++; }
    return d >= 1 && j < n && s.charCodeAt(j) === 59;
  }
  if (!isAlpha(c)) return false;
  j++;
  let d = 1;
  while (j < n && d < 32 && (isAlpha(s.charCodeAt(j)) || (s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57))) { j++; d++; }
  return j < n && s.charCodeAt(j) === 59;
}

function isHex(c) {
  return (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
}

function attrTitle(title) {
  if (title === null || title === undefined) return '';
  return ' title="' + escapeAttr(title) + '"';
}

function hrefAttr(href) {
  if (href === null || href === undefined) return '';
  const c = cleanUrl(href);
  return escapeAttr(c === null ? href : c);
}

function renderAlt(toks) {
  let out = '';
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    switch (t.k) {
      case 't': out += t.s; break;
      case 'esc': out += t.s; break;
      case 'code': out += t.s; break;
      case 'html': out += t.s; break;
      case 'br': break;
      case 'em': case 'strong': case 'del': out += renderAlt(t.children); break;
      case 'link': case 'image': out += t.children ? renderAlt(t.children) : t.text; break;
    }
  }
  return out;
}

// ---------- link reference definitions ----------

function parseRefDefs(para, refs) {
  // para.lines: array of raw strings; parse leading ref defs
  if (para.lines.length === 0) return false;
  const src = para.lines.join('\n');
  let pos = 0;
  let any = false;
  while (pos < src.length) {
    const r = tryRefDef(src, pos, src.length);
    if (!r) break;
    if (r.label.trim() === '') break;
    const key = normLabel(r.label);
    if (!refs.has(key)) refs.set(key, { href: r.href, title: r.title });
    pos = r.end;
    any = true;
  }
  if (!any) return false;
  if (pos >= src.length) { para.lines = []; return true; }
  para.lines = src.slice(pos).split('\n');
  return true;
}

function tryRefDef(src, pos, n) {
  let i = pos;
  // up to 3 spaces
  let sp = 0;
  while (i < n && sp < 3 && src.charCodeAt(i) === 32) { i++; sp++; }
  if (i >= n || src.charCodeAt(i) !== 91) return null; // [
  i++;
  // label: to first unescaped ] ; no [ inside
  const labelEnd = findLabelEnd(src, i, n);
  if (labelEnd < 0) return null;
  const label = src.slice(i, labelEnd);
  i = labelEnd + 1;
  if (i >= n || src.charCodeAt(i) !== 58) return null; // :
  i++;
  // skip whitespace incl newlines (but not blank lines: max 1 newline)
  let newlines = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 32 || c === 9) { i++; continue; }
    if (c === 10) { newlines++; i++; continue; }
    break;
  }
  if (newlines > 1) return null;
  if (i >= n) return null;
  // destination
  let dest;
  if (src.charCodeAt(i) === 60) { // <
    let j = i + 1;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 62) break;
      if (c === 60 || c === 10) return null;
      if (c === 92 && j + 1 < n && isPunct(src.charCodeAt(j + 1))) { j += 2; continue; }
      j++;
    }
    if (j >= n) return null;
    dest = unescapeString(src.slice(i + 1, j));
    i = j + 1;
  } else {
    let j = i;
    let depth = 0;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 92 && j + 1 < n && isPunct(src.charCodeAt(j + 1))) { j += 2; continue; }
      if (c <= 32) break;
      if (c === 40) { depth++; j++; continue; }
      if (c === 41) {
        if (depth === 0) break;
        depth--; j++; continue;
      }
      j++;
    }
    if (j === i) return null;
    dest = unescapeString(src.slice(i, j));
    i = j;
  }
  // optional title (may be on next line)
  let title = null;
  let j = i;
  let nls = 0;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 32 || c === 9) { j++; continue; }
    if (c === 10) { nls++; j++; continue; }
    break;
  }
  if (nls <= 1 && j < n && j > i) {
    const q = src.charCodeAt(j);
    let closeQ = 0;
    if (q === 34) closeQ = 34;
    else if (q === 39) closeQ = 39;
    else if (q === 40) closeQ = 41;
    if (closeQ) {
      let k = j + 1;
      let ok = false;
      while (k < n) {
        const c = src.charCodeAt(k);
        if (c === 92 && k + 1 < n && isPunct(src.charCodeAt(k + 1))) { k += 2; continue; }
        if (c === closeQ) { ok = true; break; }
        k++;
      }
      if (ok) {
        title = unescapeString(src.slice(j + 1, k));
        j = k + 1;
        let e = j;
        while (e < n && (src.charCodeAt(e) === 32 || src.charCodeAt(e) === 9)) e++;
        if (e < n && src.charCodeAt(e) !== 10) { title = null; } // junk after title: fall back to no title
        else {
          if (e < n) e++;
          return { label, href: cleanUrl(dest), title, end: e };
        }
      }
    }
  }
  // dest-only definition: must end at the destination's line end
  let e = i;
  while (e < n && (src.charCodeAt(e) === 32 || src.charCodeAt(e) === 9)) e++;
  if (e < n && src.charCodeAt(e) !== 10) return null;
  if (e < n) e++;
  return { label, href: cleanUrl(dest), title: null, end: e };
}

// finalize: strip ref defs from paragraphs, before rendering
function finalizeRefs(block, refs) {
  const ch = block.children;
  if (!ch) return;
  for (let i = 0; i < ch.length; i++) {
    const b = ch[i];
    if (b.type === 'para') {
      if (parseRefDefs(b, refs)) {
        if (b.lines.length === 0) {
          ch.splice(i, 1);
          i--;
        }
      }
    }
    finalizeRefs(b, refs);
  }
}

// MARKER_PART_END




