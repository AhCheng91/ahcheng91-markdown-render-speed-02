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

export function parse(markdown) {
  const md = typeof markdown === 'string' ? markdown.replace(/\r\n|\r/g, '\n') : '';
  const { doc, refs } = parseDocument(md);
  finalizeRefs(doc, refs);
  return renderBlocks(doc.children || [], refs, false, false);
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
  if (tip0.type === 'fence' && allMatched) {
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
      stack.pop();
      return li + 1;
    }
  }
  const remWsOnly = isBlankAt(text, pos, n);
  const blank = rawWsOnly || pos >= n || (remWsOnly && !isLastLine);

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
      const r = takeIndent(text, pos, n, col, tip0.type === 'code' ? 4 : tip0.fenceIndent);
      tip0.lines.push(r[2] > 0 ? ' '.repeat(r[2]) + text.slice(r[0]) : text.slice(r[0]));
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
  if (!allMatched && tip0.type !== 'para') {
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
      if (tryHtmlStart(text, p, n, true) || tryFence(text, p, n) || tryAtx(text, p, n) ||
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
      if (u > 0) {
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
        h.endNL = line.nl && !(nxt && isBlankAt(nxt.t, 0, nxt.t.length));
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
  if (!consumed && !allMatched && (tipNow.type === 'fence' || tipNow.type === 'html' || tipNow.type === 'code' || tipNow.type === 'table')) {
    closeUnmatched(stack, container);
    tipNow = stack[stack.length - 1];
  }
  if (tipNow.type === 'para') {
    if (tipNow.pendingBlank) { tipNow.lines.push(''); tipNow.pendingBlank = false; }
    tipNow.lines.push(text.slice(pos));
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
    // marked strips the fence's own indent from backtick fences only
    if (tipNow.fenceChar === 96) {
      const r = takeIndent(text, pos, n, col, tipNow.fenceIndent);
      if (r[2] > 0) tipNow.lines.push(' '.repeat(r[2]) + text.slice(r[0]));
      else tipNow.lines.push(text.slice(r[0]));
    } else {
      tipNow.lines.push(text.slice(pos));
    }
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
        tipNow.endNL = ln.nl && !(nxt && isBlankAt(nxt.t, 0, nxt.t.length));
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
      const src = b.lines.join('\n');
      if (tight) return renderInline(src.replace(/[ \t]+$/, ''), refs, false);
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
      let s = '';
      const L = b.lines;
      if (L.length) {
        for (let i = 0; i < L.length; i++) {
          s += L[i].t + (i < L.length - 1 ? '\n' : (b.endNL ? '\n' : ''));
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

function renderList(list, refs) {
  const loose = listIsLoose(list);
  const tag = list.ordered ? 'ol' : 'ul';
  let out = '<' + tag;
  if (list.ordered && list.start !== 1) out += ' start="' + list.start + '"';
  out += '>\n';
  for (const item of list.children || []) {
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
  // returns -4 for '[ ] ' (unchecked) or 4 for '[x] '/'[X] ', else null
  if (line.length < 4 || line.charCodeAt(0) !== 91 || line.charCodeAt(2) !== 93) return null;
  const c = line.charCodeAt(1);
  if (line.charCodeAt(3) !== 32) return null;
  if (c === 32) return -4;
  if (c === 120 || c === 88) return 4;
  return null;
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
  const line = t.slice(pos, end);
  if (line.indexOf('|') < 0) return null;
  const cells = splitRowAny(line);
  if (line.length > 0 && line.charCodeAt(0) === 124) cells.shift();
  if (cells.length > 0 && line.charCodeAt(line.length - 1) === 124) cells.pop();
  if (cells.length === 0) return null;
  const align = [];
  for (let c of cells) {
    c = c.trim();
    if (!/^:?-+:?$/.test(c) || c.length === 0) return null;
    const l = c.charCodeAt(0) === 58;
    const r = c.charCodeAt(c.length - 1) === 58;
    align.push(l && r ? 2 : l ? 1 : r ? 3 : 0);
  }
  return align;
}

function tryTableStart(t, pos, end, li, lines, interrupt) {
  const line = t.slice(pos, end);
  if (line.indexOf('|') < 0) return null;
  const next = lines[li + 1];
  const align = delimRow(next.t, 0, next.t.length);
  if (!align) return null;
  const cells = splitRow(line, align.length);
  if (cells.length !== align.length) return null;
  return [cells, align];
}

// a line that continues a table body: any non-blank line that does not start
// another block construct.
function isTableRow(t, pos, end, lines, li) {
  let p = pos;
  const r = skipSpace(t, p, end, 0, 3);
  if (r[1] > 3) return false;
  p = r[0];
  if (p >= end) return false;
  if (indentCols(t, pos, end, 0)[1] >= 4) return false;
  const c = t.charCodeAt(p);
  if (c === 62) return false; // > quote
  if (c === 35) return false; // # heading
  if (c === 61 || c === 45) {
    if (setextLevel(t, p, end) > 0) return false;
  }
  if (c === 96 || c === 126) {
    if (tryFence(t, p, end)) return false;
  }
  if (c === 60) {
    if (tryHtmlStart(t, p, end, false)) return false;
  }
  if ((c === 45 || c === 43 || c === 42) && (p + 1 >= end || t.charCodeAt(p + 1) === 32 || t.charCodeAt(p + 1) === 9)) return false;
  if (c >= 48 && c <= 57) {
    let j = p, digits = 0;
    while (j < end && t.charCodeAt(j) >= 48 && t.charCodeAt(j) <= 57) { j++; digits++; }
    if (digits <= 9 && j < end && (t.charCodeAt(j) === 46 || t.charCodeAt(j) === 41)) return false;
  }
  if (isThematic(t, p, end)) return false;
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

  // spaces after marker (columns)
  let j = i;
  let col2 = col;
  let spaces = 0;
  let sawTab = false;
  let padStart = -1, padW = 0;
  while (j < n) {
    const cc = text.charCodeAt(j);
    if (cc === 32) { j++; col2++; spaces++; }
    else if (cc === 9) {
      const w = 4 - (col2 & 3);
      j++; col2 += w; spaces += w;
      sawTab = true; padStart = col2 - w + 1; padW = w;
    } else break;
  }
  let contentIndent;
  if (j >= n) {
    contentIndent = col + 1; // marker end col + 1
  } else if (spaces <= 4) {
    contentIndent = col2;
  } else {
    contentIndent = col + 1;
  }

  const item = addChild(list, newBlock('item', list));
  item.contentIndent = contentIndent - c;
  item.contentIndentAbs = contentIndent;
  stack.push(item);

  if (j >= n) return [j, col2, false, null, n];
  // consume contentIndent - col columns from the line (first line)
  const want = contentIndent - col;
  const r = takeIndent(text, i, n, col, want);
  if (r[2] > 0) {
    const rest = text.slice(r[0]);
    return [0, r[1], true, ' '.repeat(r[2]) + rest, r[2] + text.length - r[0]];
  }
  return [r[0], r[1], false, null, n];
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
function tokenizeInline(src, refs, toks, delims, brackets) {
  const n = src.length;
  let i = 0;
  let bufStart = -1;
  let bufEnd = -1;

  function flush() {
    if (bufStart >= 0 && bufEnd > bufStart) {
      toks.push({ k: 't', s: src.slice(bufStart, bufEnd) });
    }
    bufStart = -1; bufEnd = -1;
  }

  while (i < n) {
    const c = src.charCodeAt(i);
    switch (c) {
      case 92: {
        if (bufStart < 0) { bufStart = i; bufEnd = i; }
        if (i + 1 < n) {
          const nc = src.charCodeAt(i + 1);
          if (nc === 10) {
            let e = bufEnd;
            while (e > bufStart && src.charCodeAt(e - 1) === 32) e--;
            bufEnd = e;
            flush();
            toks.push({ k: 'br' });
            i += 2;
            while (i < n && src.charCodeAt(i) === 32) i++;
            continue;
          }
          if (nc < 128 && PUNCT[nc] === 1) {
            flush();
            toks.push({ k: 't', s: src[i + 1] });
            i += 2;
            continue;
          }
        }
        bufEnd = i + 1;
        i++;
        continue;
      }
      case 96: {
        flush();
        let j = i;
        while (j < n && src.charCodeAt(j) === 96) j++;
        const len = j - i;
        let k = j;
        let found = -1;
        while (k < n) {
          if (src.charCodeAt(k) === 96) {
            let m = k;
            while (m < n && src.charCodeAt(m) === 96) m++;
            if (m - k === len) { found = k; k = m; break; }
            k = m;
          } else k++;
        }
        if (found >= 0) {
          let content = src.slice(j, found);
          if (content.indexOf('\n') >= 0) content = content.replace(/\n/g, ' ');
          if (content.length > 0 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && content.trim().length > 0) {
            content = content.slice(1, -1);
          }
          toks.push({ k: 'code', s: content });
          i = k;
        } else {
          toks.push({ k: 't', s: src.slice(i, j) });
          i = j;
        }
        continue;
      }
      case 38: {
        const num = decodeNumericEntity(src, i);
        if (num) {
          flush();
          toks.push({ k: 'ent', s: escapeHtml(num[0]) });
          i = num[1];
          continue;
        }
        const nm = tryNamedEntity(src, i);
        if (nm) {
          flush();
          toks.push({ k: 'ent', s: nm[0] });
          i = nm[1];
          continue;
        }
        if (bufStart < 0) { bufStart = i; bufEnd = i; }
        bufEnd = i + 1;
        i++;
        continue;
      }
      case 60: {
        flush();
        const al = tryAutolink(src, i);
        if (al) {
          const href = cleanUrl(al[2]);
          toks.push({ k: 'link', href, title: null, text: al[1], auto: true });
          i = al[0];
          continue;
        }
        const tag = scanTag(src, i, n);
        if (tag) {
          toks.push({ k: 'html', s: src.slice(i, tag[1]) });
          i = tag[1];
          continue;
        }
        const c2 = scanComment(src, i, n);
        if (c2) {
          toks.push({ k: 'html', s: src.slice(i, c2) });
          i = c2;
          continue;
        }
        const spec = scanSpecialHtml(src, i, n);
        if (spec) {
          toks.push({ k: 'html', s: src.slice(i, spec) });
          i = spec;
          continue;
        }
        toks.push({ k: 't', s: '<' });
        i++;
        continue;
      }
      case 42: case 95: {
        flush();
        let j = i;
        while (j < n && src.charCodeAt(j) === c) j++;
        const runLen = j - i;
        const before = i > 0 ? src.charCodeAt(i - 1) : 10;
        const after = j < n ? src.charCodeAt(j) : 10;
        const leftFl = canFlankLeft(after, before);
        const rightFl = canFlankRight(before, after);
        let canOpen = leftFl;
        let canClose = rightFl;
        if (c === 95) {
          if (leftFl && rightFl && !isPunct(before) && !isPunct(after) && !isSpace(before) && !isSpace(after)) {
            canOpen = false; canClose = false;
          }
        }
        const tok = { k: 't', s: src.slice(i, j) };
        toks.push(tok);
        delims.push({ ch: c, count: runLen, open: canOpen, close: canClose, tok, dead: false });
        i = j;
        continue;
      }
      case 126: {
        flush();
        let j = i;
        while (j < n && src.charCodeAt(j) === 126) j++;
        const runLen = j - i;
        if (runLen === 1 || runLen === 2) {
          const before = i > 0 ? src.charCodeAt(i - 1) : 10;
          const after = j < n ? src.charCodeAt(j) : 10;
          const tok = { k: 't', s: src.slice(i, j) };
          toks.push(tok);
          delims.push({ ch: 126, count: runLen, open: canFlankLeft(after, before), close: canFlankRight(before, after), tok, dead: false });
        } else {
          toks.push({ k: 't', s: src.slice(i, j) });
        }
        i = j;
        continue;
      }
      case 91: {
        flush();
        brackets.push({ pos: toks.length, image: false, active: true, delimBottom: delims.length, srcStart: i });
        toks.push({ k: 't', s: '[' });
        i++;
        continue;
      }
      case 33: {
        if (i + 1 < n && src.charCodeAt(i + 1) === 91) {
          flush();
          brackets.push({ pos: toks.length, image: true, active: true, delimBottom: delims.length, srcStart: i });
          toks.push({ k: 't', s: '![' });
          i += 2;
          continue;
        }
        if (bufStart < 0) { bufStart = i; bufEnd = i; }
        bufEnd = i + 1;
        i++;
        continue;
      }
      case 93: {
        flush();
        const nb = brackets[brackets.length - 1];
        if (nb && !nb.active) {
          brackets.pop();
          toks.push({ k: 't', s: ']' });
          i++;
          continue;
        }
        i = handleBracket(src, i, n, toks, delims, brackets, refs);
        continue;
      }
      case 10: {
        if (bufStart >= 0) {
          let e = bufEnd;
          let spaces = 0;
          while (e > bufStart && src.charCodeAt(e - 1) === 32) { e--; spaces++; }
          if (spaces === 1) e++;
          bufEnd = e;
          flush();
          toks.push({ k: spaces >= 2 ? 'br' : 'nl' });
          if (spaces >= 2) {
            let k = i + 1;
            while (k < n && src.charCodeAt(k) === 32) k++;
            i = k - 1;
          }
        } else {
          toks.push({ k: 'nl' });
        }
        i++;
        continue;
      }
      case 64: {
        const em = tryExtEmail(src, i, bufStart);
        if (em) {
          if (bufStart >= 0 && em[2] >= bufStart) {
            bufEnd = em[2];
            if (bufEnd <= bufStart) { bufStart = -1; bufEnd = -1; }
            flush();
          } else flush();
          toks.push({ k: 'link', href: 'mailto:' + em[0], title: null, text: em[0], auto: true, ext: true });
          i = em[1];
          continue;
        }
        if (bufStart < 0) { bufStart = i; bufEnd = i; }
        bufEnd = i + 1;
        i++;
        continue;
      }
      default: {
        const c0 = src.charCodeAt(i);
        if ((c0 >= 48 && c0 <= 57) || (c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
          const em1 = tryExtEmailAt(src, i, bufStart);
          if (em1) {
            flush();
            toks.push({ k: 'link', href: 'mailto:' + em1[0], title: null, text: em1[0], auto: true, ext: true });
            i = em1[1];
            continue;
          }
        }
        const ext = tryExtUrl(src, i, bufStart, brackets.length > 0);
        if (ext) {
          flush();
          toks.push({ k: 'link', href: ext[2], title: null, text: ext[0], auto: true, ext: true });
          i = ext[1];
          continue;
        }
        if (bufStart < 0) { bufStart = i; bufEnd = i; }
        bufEnd = i + 1;
        i++;
      }
    }
  }
  flush();
}

function canFlankLeft(after, before) {
  if (isSpace(after)) return false;
  if (!isPunct(after)) return true;
  return isSpace(before) || isPunct(before);
}

function canFlankRight(before, after) {
  if (isSpace(before)) return false;
  if (!isPunct(before)) return true;
  return isSpace(after) || isPunct(after);
}

function isSpace(c) { return c === 32 || c === 9 || c === 10 || (c >= 0x0b && c <= 0x0d) || (c >= 0x2000 && c <= 0x200a) || c === 0x1680 || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xa0; }

function isDisallowedTag(name) {
  return name === 'title' || name === 'textarea' || name === 'style' || name === 'xmp' ||
    name === 'iframe' || name === 'noembed' || name === 'noframes' || name === 'script' || name === 'plaintext';
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

// <?...?>, <!LETTER...> and <![CDATA[...]]> inline HTML
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

// ---------- bracket handling at ] ----------

function handleBracket(src, i, n, toks, delims, brackets, refs) {
  const b = brackets[brackets.length - 1];
  if (!b) { toks.push({ k: 't', s: ']' }); return i + 1; }

  const openLen = b.image ? 2 : 1;
  const innerSrc = src.slice(b.srcStart + openLen, i);

  let result = null;
  let explicit = false; // a following () or [] was present, so no shortcut fallback

  // inline link/image: (dest "title")
  if (i + 1 < n && src.charCodeAt(i + 1) === 40) { // (
    result = parseInlineDest(src, i + 1, n);
  }
  // reference links
  if (!result && i + 1 < n && src.charCodeAt(i + 1) === 91 && i + 2 < n && src.charCodeAt(i + 2) === 93) { // [foo][]
    explicit = true;
    const r = lookupRef(refs, innerSrc);
    if (r) result = { href: r.href, title: r.title, consumedTo: i + 3 };
  }
  if (!result && i + 1 < n && src.charCodeAt(i + 1) === 91) { // [label]
    explicit = true;
    const end2 = findLabelEnd(src, i + 2, n);
    if (end2 >= 0) {
      const label = src.slice(i + 2, end2);
      const r = lookupRef(refs, label);
      if (r) result = { href: r.href, title: r.title, consumedTo: end2 + 1 };
    }
  }
  if (!result && !explicit) {
    const r = lookupRef(refs, innerSrc);
    if (r) result = { href: r.href, title: r.title, consumedTo: i + 1 };
  }

  if (result) {
    processEmphasis(delims, b.delimBottom, toks);
    const innerToks = toks.slice(b.pos + 1, toks.length);
    const linkTok = {
      k: b.image ? 'image' : 'link',
      href: result.href, title: result.title || null,
      children: innerToks,
    };
    toks.length = b.pos;
    toks.push(linkTok);
    if (!b.image) for (const ob of brackets) if (!ob.image) ob.active = false;
    brackets.pop();
    // the link text's delimiters are resolved now
    delims.length = b.delimBottom;
    return result.consumedTo;
  }

  // failed: pop bracket, literal ]
  brackets.pop();
  toks.push({ k: 't', s: ']' });
  return i + 1;
}

// ---------- emphasis ----------

function processEmphasis(delims, bottom, toks) {
  for (let ci = bottom; ci < delims.length; ci++) {
    const closer = delims[ci];
    if (!closer || closer.dead || !closer.close) continue;
    // find opener
    let opener = null;
    let oi = -1;
    for (let k = ci - 1; k >= bottom; k--) {
      const o = delims[k];
      if (o.dead || !o.open || o.ch !== closer.ch) continue;
      if (closer.ch !== 126 && (o.close || closer.open)) {
        const sum = o.count + closer.count;
        if (sum % 3 === 0 && !(o.count % 3 === 0 && closer.count % 3 === 0)) continue;
      }
      opener = o; oi = k; break;
    }
    if (!opener) continue;
    let use;
    let strong = false;
    if (closer.ch === 126) {
      if (opener.count !== closer.count) continue;
      use = closer.count;
    } else {
      strong = closer.count >= 2 && opener.count >= 2;
      use = strong ? 2 : 1;
    }
    // find token indices
    const oi2 = toks.indexOf(opener.tok);
    const ci2 = toks.indexOf(closer.tok);
    if (oi2 < 0 || ci2 < 0 || ci2 <= oi2) { closer.dead = true; continue; }
    const ch = String.fromCharCode(opener.ch);
    const content = toks.slice(oi2 + 1, ci2);
    const node = { k: closer.ch === 126 ? 'del' : (strong ? 'strong' : 'em'), children: content };
    const newToks = [];
    if (opener.count - use > 0) newToks.push({ k: 't', s: ch.repeat(opener.count - use) });
    newToks.push(node);
    if (closer.count - use > 0) newToks.push({ k: 't', s: ch.repeat(closer.count - use) });
    toks.splice(oi2, ci2 - oi2 + 1, ...newToks);
    // delimiters between opener and closer cannot match any more
    for (let k = oi + 1; k < ci; k++) delims[k].dead = true;
    opener.count -= use;
    closer.count -= use;
    if (opener.count === 0) opener.dead = true;
    else opener.tok = newToks[0];
    if (closer.count === 0) {
      closer.dead = true;
    } else {
      closer.tok = newToks[newToks.length - 1];
      ci--;
    }
  }
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
  if (/[-_]/.test(rawDom.slice(dom.length))) return null;
  if (dom.length < rawDom.length) i = domStart + dom.length;
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
  if (/[-_]/.test(rawDom.slice(dom.length))) return null;
  if (dom.length < rawDom.length) i = domStart + dom.length;
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
    if (inBracket && (c === 91 || c === 93)) break;
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
  if (/[-_]/.test(rawDom.slice(dom.length))) return null;
  if (dom.length < rawDom.length) i = domStart + dom.length;
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

function renderInline(src, refs, inLink) {
  const toks = [];
  const delims = [];
  const brackets = [];
  tokenizeInline(src, refs, toks, delims, brackets);
  processEmphasis(delims, 0, toks);
  return renderTokens(toks, refs, inLink);
}

function renderTokens(toks, refs, inLink) {
  let out = '';
  for (const t of toks) {
    switch (t.k) {
      case 't': out += escapeHtml(t.s); break;
      case 'ent': out += t.s; break;
      case 'code': out += '<code>' + escapeCode(t.s.replace(/\n/g, ' ')) + '</code>'; break;
      case 'html': out += t.s; break;
      case 'br': out += '<br>'; break;
      case 'nl': out += '\n'; break;
      case 'em': out += '<em>' + renderTokens(t.children, refs, inLink) + '</em>'; break;
      case 'strong': out += '<strong>' + renderTokens(t.children, refs, inLink) + '</strong>'; break;
      case 'del': out += '<del>' + renderTokens(t.children, refs, inLink) + '</del>'; break;
      case 'link': {
        if (t.ext && inLink) { out += escapeHtml(t.text); break; }
        if (t.children) {
          out += '<a href="' + hrefAttr(t.href) + '"' + attrTitle(t.title) + '>' +
            renderTokens(t.children, refs, true) + '</a>';
        } else {
          out += '<a href="' + hrefAttr(t.href) + '"' + attrTitle(t.title) + '>' + escapeHtml(t.text) + '</a>';
        }
        break;
      }
      case 'image': {
        const alt = renderAlt(t.children, refs);
        out += '<img src="' + hrefAttr(t.href) + '" alt="' + alt + '"' + attrTitle(t.title) + '>';
        break;
      }
    }
  }
  return out;
}

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

function renderAlt(toks, refs) {
  let out = '';
  for (const t of toks) {
    switch (t.k) {
      case 't': out += escapeHtml(t.s); break;
      case 'ent': out += t.s; break;
      case 'code': out += t.s.replace(/\n/g, ' '); break;
      case 'html': out += ''; break;
      case 'br': out += ''; break;
      case 'nl': out += ' '; break;
      case 'em': case 'strong': case 'del': out += renderAlt(t.children, refs); break;
      case 'link': out += renderAlt(t.children || [], refs); break;
      case 'image': out += renderAlt(t.children || [], refs); break;
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




