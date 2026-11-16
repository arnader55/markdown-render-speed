// SwiftMark — a from-scratch CommonMark 0.31.2 + GFM parser, written to
// return byte-for-byte the HTML marked 18.1.3 renders with its defaults
// (GFM on, breaks off, pedantic off). No dependencies, no network, no
// clock or environment reads, fully deterministic. Written from the
// CommonMark and GFM specifications and the marked 18.1.3 output forms
// (its escaping, entity handling and attribute order), not from any
// existing implementation's code.

'use strict';

// Document-level "inside a link" flag, leaked across blocks the way
// marked's does: an inline <a ...> open tag sets it and only a </a>
// close tag (as inline HTML, in any later paragraph) clears it. While
// set, bare (extended) autolinks do not form; markdown links, <...>
// autolinks, images and reference links are unaffected. Reset at the
// start of every parse() call.
let inLinkLeak = false;

function htmlTagNameIsA(text) {
  // Returns 'open' for <a ...>, 'close' for </a ...>, '' otherwise.
  if (text.length < 2 || text[0] !== '<') return '';
  let i = 1;
  let close = false;
  if (text[i] === '/') { close = true; i++; }
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  if (i >= text.length || !isAlpha(text[i])) return '';
  if (text[i] !== 'a' && text[i] !== 'A') return '';
  const after = text[i + 1];
  if (after !== undefined && (isAlnum(after) || after === '-')) return '';
  return close ? 'close' : 'open';
}

// ---------------------------------------------------------------- utilities

const SPACE_RE = /[ \t\n\r\f\v]/;
const ASCII_PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}
function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}
function isAlpha(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}
function isAlnum(ch) {
  return isAlpha(ch) || isDigit(ch);
}
function isAsciiPunct(ch) {
  return ASCII_PUNCT.indexOf(ch) !== -1;
}
// Unicode punctuation or symbol (for flanking rules).
const PUNCT_RE = /\p{P}|\p{S}/u;
const ALNUM_RE = /\p{L}|\p{N}/u;
function isPunct(ch) {
  return isAsciiPunct(ch) || PUNCT_RE.test(ch);
}
function isUnicodeWhitespace(ch) {
  return SPACE_RE.test(ch) || /\s/.test(ch);
}

// Escape text and attribute values exactly the way marked does:
// & < > " ' are all escaped, even in plain text.
function escapeHtml(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
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
  return start === 0 ? s : out + s.slice(start);
}

// ---------------------------------------------------------------- entities

// marked does not decode named character references in text: a reference
// like &copy; is output verbatim. Only numeric references are decoded,
// and only when the value is in range (0..0x10FFFF); 0 and surrogates
// become U+FFFD. An out-of-range or malformed numeric reference is not
// an entity at all, so its '&' is escaped as literal text.

// Decode a numeric character reference starting at src[i] === '&'.
// Returns [decodedString, lengthConsumed] or null.
function decodeNumericEntityAt(src, i) {
  const n = src.length;
  if (i + 2 >= n || src[i + 1] !== '#') return null;
  let j = i + 2;
  let hex = false;
  if (src[j] === 'x' || src[j] === 'X') { hex = true; j++; }
  let val = 0;
  let digits = 0;
  while (j < n) {
    const ch = src[j];
    let d = -1;
    if (ch >= '0' && ch <= '9') d = ch.charCodeAt(0) - 48;
    else if (hex && ch >= 'a' && ch <= 'f') d = ch.charCodeAt(0) - 87;
    else if (hex && ch >= 'A' && ch <= 'F') d = ch.charCodeAt(0) - 55;
    else break;
    val = val * (hex ? 16 : 10) + d;
    digits++;
    j++;
    if (hex ? digits > 6 : digits > 7) return null;
  }
  if (digits === 0 || j >= n || src[j] !== ';') return null;
  if (val > 0x10ffff) return null;
  if (val === 0 || (val >= 0xd800 && val <= 0xdfff)) val = 0xfffd;
  return [String.fromCodePoint(val), j - i + 1];
}

// Length of a named character reference '&word;' at src[i], or 0. Any
// word of letters, digits and '_' counts: marked passes it through
// verbatim whether or not it names a defined character.
function matchNamedEntity(src, i) {
  const n = src.length;
  if (i + 1 >= n || !isAlnum(src[i + 1])) return 0;
  let j = i + 1;
  while (j < n && (isAlnum(src[j]) || src[j] === '_')) j++;
  if (j >= n || src[j] !== ';') return 0;
  return j - i + 1;
}

// Length of any character reference (numeric or named) at src[i], or 0.
// Used to decide whether a trailing ';' closes an entity.
function entityLengthAt(src, i) {
  const d = decodeNumericEntityAt(src, i);
  if (d) return d[1];
  return matchNamedEntity(src, i);
}

// Decode only backslash escapes in a short string (link destinations,
// titles, fenced-code info strings). Entities are left untouched.
function unescapePunct(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < n && isAsciiPunct(s[i + 1])) {
      out += s[i + 1];
      i += 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

// Escape an attribute value the way marked does: & < > " ' are escaped,
// except that an '&' starting a character reference (&word;, &#123;,
// &#x1F;) is left alone, so entity references survive in hrefs and
// titles.
function escapeAttr(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) {
      if (!entityLengthAt(s, i)) rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (i > start) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// ------------------------------------------------------------ URL cleaning

// Marked's cleanUrl: decode any percent-escapes already present, then
// percent-encode the URL the way encodeURI does (space -> %20, backslash
// -> %5C, '"' -> %22, non-ASCII -> UTF-8 %XX). Dangerous schemes
// (javascript:, vbscript:, data: except data:image/*) are rejected.
// Returns the cleaned URL, or '' when it is unsafe or undecodable.
function cleanUrl(href) {
  if (!href) return href;
  let url;
  try {
    url = encodeURI(decodeURIComponent(href));
  } catch (e) {
    // A stray '%' (not a valid escape) does not wipe the URL: encode
    // the raw href, but keep '%' itself as-is (marked leaves it).
    url = encodeURI(href.replace(/%/g, '\u0000')).replace(/%00/g, '%');
  }
  const m = url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (m) {
    const scheme = m[1].toLowerCase();
    if (scheme === 'javascript' || scheme === 'vbscript') return '';
    if (scheme === 'data' && !/^data:image\//i.test(url)) return '';
  }
  return url;
}


// ---------------------------------------------------------- inline parsing

// Node kinds in the inline linked list:
//  text:    {s} raw text (escaped at render)
//  delim:   {ch:'*'|'_'|'~', n, canOpen, canClose} emphasis delimiter (literal when unused)
//  bracket: {image, active, pos} '[' or '![' opener (literal when unused)
//  code:    {html} pre-rendered code span
//  html:    {s} raw inline HTML
//  br:      hard break
//  autolink:{href, text} an <...> or extended autolink
//  em/strong/del: {children:[nodes]} emphasis wrappers
//  link:    {href, title, children:[nodes]}
//  image:   {href, title, alt} (alt pre-rendered from children)
//
// Delimiters live in a second doubly linked list (stack order = document
// order); each holds a reference to its node.

function parseInline(src, refs) {
  const n = src.length;
  const root = { t: 'root', next: null, prev: null };
  let tail = root;
  let buf = '';
  let dHead = null;
  let dTail = null;
  // Every '*' pair formed in this paragraph, in order: {openerPos,
  // closerPos, closerLen, closerEnd, use}. Used by the marked quirk
  // that an outer '*' pair fails (and a closer's leftover stars land
  // inside it) when an inner '*' pair's closer is followed by an
  // alphanumeric character.
  const formedStar = [];

  function appendNode(node) {
    tail.next = node; node.prev = tail; tail = node;
  }
  function flushText() {
    if (buf.length) {
      const node = { t: 'text', s: buf, next: null, prev: null };
      buf = '';
      appendNode(node);
    }
  }
  function pushDelim(d) {
    d.prev = dTail; d.next = null;
    if (dTail) dTail.next = d; else dHead = d;
    dTail = d;
  }
  function removeDelim(d) {
    if (d.prev) d.prev.next = d.next; else dHead = d.next;
    if (d.next) d.next.prev = d.prev; else dTail = d.prev;
    d.prev = null; d.next = null;
  }
  function removeNode(node) {
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
    if (tail === node) tail = node.prev;
    node.prev = null; node.next = null;
  }
  function insertAfter(a, b) {
    b.next = a.next; b.prev = a;
    if (a.next) a.next.prev = b;
    a.next = b;
    if (tail === a) tail = b;
  }

  // Wrap the nodes strictly between openNode and closeNode in an
  // em/strong/del node (use 1 = em, 2 = strong/del). Delimiter nodes
  // strictly between the two are dropped from the delimiter stack: once
  // wrapped, they can match nothing further. The open/close delimiter
  // nodes keep any leftover length as literal text around the wrapper.
  function wrapEmphasis(openNode, closeNode, use, ch) {
    const children = [];
    let cur = openNode.next;
    while (cur !== closeNode && cur !== null) {
      const nxt = cur.next;
      children.push(cur);
      cur.prev = null; cur.next = null;
      cur = nxt;
    }
    const node = {
      t: ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em'),
      children, next: null, prev: null,
    };
    // Rewire the main list: ... prev - [openNode?] - node - [closeNode?] - next ...
    const prev = openNode.prev;
    if (openNode.t === 'delim' && openNode.n === 0) {
      if (prev) prev.next = node;
      node.prev = prev;
    } else {
      openNode.next = node;
      node.prev = openNode;
    }
    if (closeNode.t === 'delim' && closeNode.n === 0) {
      node.next = closeNode.next;
      if (closeNode.next) closeNode.next.prev = node;
      if (tail === closeNode) tail = node;
    } else {
      node.next = closeNode;
      closeNode.prev = node;
    }
    if (tail === openNode && openNode.n === 0) tail = node;
    return node;
  }

  // The spec's process-emphasis, restricted to the delimiters in the
  // doubly linked range (stopNode, tailNode] — stopNode exclusive, or
  // null to run to the head. Walks closers from the end, matching each
  // with the nearest earlier opener of the same character.
  function processEmphasis(tailNode, stopNode) {
    // Closers are processed left to right (document order): each closer
    // takes the nearest preceding opener that the odd-match rule allows.
    const end = tailNode ? tailNode.next : null;
    let closer = stopNode ? stopNode.next : dHead;
    while (closer && closer !== end) {
      const next = closer.next;
      if (closer.type === 'em' && closer.canClose) {
        let opener = closer.prev;
        let found = null;
        while (opener && opener !== stopNode) {
          if (opener.type === 'em' && opener.ch === closer.ch && opener.canOpen) {
            const odd = (opener.canClose || closer.canOpen) &&
              ((opener.n + closer.n) % 3 === 0) &&
              (opener.n % 3 !== 0 || closer.n % 3 !== 0);
            if (!odd) {
              // Marked quirk: an outer '*' pair is blocked when an inner
              // '*' pair has formed strictly between the opener and the
              // closer and that inner pair's closer is immediately
              // followed by an alphanumeric character. The block applies
              // when the (opener, inner closer) pair or the (inner
              // closer, outer closer) pair is a multiple of three in
              // length (rule-of-three shape), and only while the outer
              // closer's original run is at most 2 long.
              let blocked = false;
              if (closer.ch === '*') {
                for (const p of formedStar) {
                  if (p.openerPos > opener.pos && p.closerPos < closer.pos &&
                      p.closerEnd < n && isAlnum(src[p.closerEnd]) &&
                      (p.openerPos === 0 || !isAlnum(src[p.openerPos - 1]))) {
                    // Shield: a lone closer-only '*' strictly between
                    // the inner pair's closer and this closer, with a
                    // non-whitespace character after it, lifts the
                    // block — but only when the inner pair is a single
                    // '*' pair (closer length 1); the outer pair then
                    // forms.
                    let shielded = false;
                    if (p.closerLen === 1) {
                    let j = p.closerEnd;
                    while (j < closer.pos) {
                      const c2 = src[j];
                      if (c2 === '\\' && j + 1 < closer.pos) { j += 2; continue; }
                      if (c2 === '`') {
                        let k = j;
                        while (k < closer.pos && src[k] === '`') k++;
                        const run = k - j;
                        let fnd = -1;
                        let m = k;
                        while (m < closer.pos) {
                          if (src[m] === '`') {
                            let e = m;
                            while (e < closer.pos && src[e] === '`') e++;
                            if (e - m === run) { fnd = m; break; }
                            m = e;
                          } else m++;
                        }
                        if (fnd >= 0) { j = fnd + run; continue; }
                        j = k; continue;
                      }
                      if (c2 === '*' && (j === 0 || src[j - 1] !== '*') &&
                          (j + 1 >= closer.pos || src[j + 1] !== '*')) {
                        const before = j > 0 ? src[j - 1] : '\n';
                        const after = j + 1 < n ? src[j + 1] : '\n';
                        if (!isUnicodeWhitespace(before) &&
                            (isUnicodeWhitespace(after) || isPunct(after))) {
                          let taken = false;
                          for (const q of formedStar) {
                            if (q.openerPos === j || q.closerPos === j) { taken = true; break; }
                          }
                          if (!taken) {
                            for (let k = j + 1; k < closer.pos; k++) {
                              if (!isUnicodeWhitespace(src[k])) { shielded = true; break; }
                            }
                          }
                        }
                        if (shielded) break;
                      }
                      j++;
                    }
                    }
                    if (shielded) continue;
                    const condA = ((opener.len + p.closerLen) % 3 === 0) &&
                      (opener.len % 3 !== 0 || p.closerLen % 3 !== 0) &&
                      (closer.len <= 2);
                    const condB = (p.closerLen >= 2) &&
                      ((p.closerLen + closer.len) % 3 === 0) &&
                      (p.closerLen % 3 !== 0 || closer.len % 3 !== 0) &&
                      (closer.len <= 2);
                    if (condA || condB) { blocked = true; break; }
                  }
                }
              }
              if (!blocked) { found = opener; break; }
            }
          }
          opener = opener.prev;
        }
        if (found) {
          const use = (found.n >= 2 && closer.n >= 2) ? 2 : 1;
          if (closer.ch === '*') {
            formedStar.push({ openerPos: found.pos, closerPos: closer.pos, closerLen: closer.len, closerEnd: closer.pos + closer.len, use });
          }
          found.n -= use;
          closer.n -= use;
          found.node.n -= use;
          closer.node.n -= use;
          // Drop every delimiter strictly between opener and closer.
          let d = found.next;
          while (d && d !== closer) {
            const nxt = d.next;
            removeDelim(d);
            d = nxt;
          }
          const wrapper = wrapEmphasis(found.node, closer.node, use, closer.ch);
          // Leftover stars of a partially used closer land INSIDE the
          // wrapper (before its closing tag) when an inner '*' pair
          // whose closer is followed by an alphanumeric has
          // (inner length + use) == 3 and the opener is exhausted and
          // no earlier opener could still take the closer.
          if (closer.ch === '*' && closer.n > 0 && found.n === 0) {
            let inside = false;
            for (const p of formedStar) {
              if (p.openerPos > found.pos && p.closerPos < closer.pos &&
                  p.closerEnd < n && isAlnum(src[p.closerEnd]) &&
                  p.closerLen + use === 3) { inside = true; break; }
            }
            if (inside) {
              let earlier = found.prev;
              let hasEarlierOpener = false;
              while (earlier && earlier !== stopNode) {
                if (earlier.type === 'em' && earlier.ch === '*' && earlier.canOpen) { hasEarlierOpener = true; break; }
                earlier = earlier.prev;
              }
              if (!hasEarlierOpener) {
                wrapper.children.push({ t: 'text', s: '*'.repeat(closer.n), next: null, prev: null });
                closer.n = 0;
                closer.node.n = 0;
              }
            }
          }
          if (found.n === 0) removeDelim(found);
          if (closer.n === 0) {
            removeDelim(closer);
            closer = next;
          }
          // Otherwise the closer still has length: retry it.
          continue;
        }
      }
      closer = next;
    }
  }

  // ---- link helpers -------------------------------------------------------

  // Labels match case-insensitively under Unicode case folding: the
  // sharp s (ß, ẞ) folds to 'ss' and the final sigma (ς) to 'σ'.
  function normalizeLabel(label) {
    return label.replace(/\s+/g, ' ').trim().toLowerCase()
      .replace(/ß/g, 'ss').replace(/ς/g, 'σ');
  }

  function skipSpaces(src, i) {
    while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n')) i++;
    return i;
  }

  // Parse a link destination starting at i. Returns {dest, next} or null.
  function scanDest(src, i) {
    const n2 = src.length;
    if (src[i] === '<') {
      let k = i + 1;
      let d = '';
      while (k < n2) {
        const c = src[k];
        if (c === '\n' || c === '<') return null;
        if (c === '>') return { dest: d, next: k + 1 };
        if (c === '\\' && k + 1 < n2 && isAsciiPunct(src[k + 1])) { d += src[k + 1]; k += 2; continue; }
        d += c;
        k++;
      }
      return null;
    }
    let k = i;
    let d = '';
    let depth = 0;
    while (k < n2) {
      const c = src[k];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') break;
      if (c.charCodeAt(0) < 32) break;
      if (c === '\\' && k + 1 < n2 && isAsciiPunct(src[k + 1])) { d += src[k + 1]; k += 2; continue; }
      if (c === '(') { depth++; d += c; k++; continue; }
      if (c === ')') {
        if (depth === 0) break;
        depth--; d += c; k++; continue;
      }
      d += c;
      k++;
    }
    return { dest: d, next: k };
  }

  // Parse a link title starting at i. Returns {title, next} or null.
  function scanTitle(src, i) {
    const n2 = src.length;
    const q = src[i];
    if (q === '"' || q === "'") {
      let k = i + 1;
      let t = '';
      while (k < n2) {
        const c = src[k];
        if (c === q) return { title: t, next: k + 1 };
        if (c === '\\' && k + 1 < n2 && isAsciiPunct(src[k + 1])) { t += src[k + 1]; k += 2; continue; }
        t += c;
        k++;
      }
      return null;
    }
    if (q === '(') {
      let k = i + 1;
      let t = '';
      let depth = 1;
      while (k < n2) {
        const c = src[k];
        if (c === '\\' && k + 1 < n2 && isAsciiPunct(src[k + 1])) { t += src[k + 1]; k += 2; continue; }
        if (c === '(') { depth++; t += c; k++; continue; }
        if (c === ')') {
          depth--;
          if (depth === 0) return { title: t, next: k + 1 };
          t += c; k++; continue;
        }
        t += c;
        k++;
      }
      return null;
    }
    return null;
  }

  // Parse the "(dest title)" of an inline link, i at '('. Returns null or
  // {dest, title, next} with next just past the closing ')'.
  function parseInlineLinkRest(src, i) {
    let j = skipSpaces(src, i + 1);
    const d = scanDest(src, j);
    if (!d) return null;
    j = skipSpaces(src, d.next);
    let title = null;
    if (src[j] === '"' || src[j] === "'" || src[j] === '(') {
      const t = scanTitle(src, j);
      if (!t) return null;
      title = t.title;
      j = skipSpaces(src, t.next);
    }
    if (src[j] !== ')') return null;
    return { dest: d.dest, title, next: j + 1 };
  }

  // Scan a reference label starting at i ('['). Returns {label, next} or null.
  // Scan a bracketed label starting at src[i] === '['. Returns
  // {label, next} or null. Backslash escapes are kept literally in the
  // label (so [foo\!] does not match a [foo!] definition), but an
  // escaped ']' does not close the label. A label may not contain a
  // nested '['.
  function scanBracketLabel(src, i) {
    const n2 = src.length;
    let k = i + 1;
    let label = '';
    while (k < n2) {
      const c = src[k];
      if (c === '\\' && k + 1 < n2 && isAsciiPunct(src[k + 1])) { label += src[k] + src[k + 1]; k += 2; continue; }
      if (c === '[') return null;
      if (c === ']') return { label, next: k + 1 };
      label += c;
      k++;
      if (label.length > 999) return null;
    }
    return null;
  }

  // Render a list of child nodes to HTML (children of em/link/...).
  function renderChildren(children) {
    let out = '';
    for (let i = 0; i < children.length; i++) out += renderNode(children[i]);
    return out;
  }

  // Plain text of a node's children, with tags stripped (for image alt).
  function textOf(children) {
    let out = '';
    for (let i = 0; i < children.length; i++) {
      const node = children[i];
      if (node.t === 'text') out += node.s;
      else if (node.t === 'delim') out += node.ch.repeat(node.n);
      else if (node.t === 'bracket') out += node.image ? '![' : '[';
      else if (node.t === 'code') out += node.plain;
      else if (node.t === 'br') out += '\n';
      else if (node.t === 'entity') out += node.s;
      else if (node.t === 'autolink') out += node.text;
      else if (node.t === 'image') out += node.alt;
      else if (node.children) out += textOf(node.children);
    }
    return out;
  }

  function renderNode(node) {
    switch (node.t) {
      case 'text': return escapeHtml(node.s);
      case 'entity': return node.s;
      case 'delim': return escapeHtml(node.ch.repeat(node.n));
      case 'bracket': return node.image ? '![' : '[';
      case 'code': return node.html;
      case 'html': return node.s;
      case 'br': return '<br>';
      case 'autolink': return '<a href="' + escapeAttr(node.href) + '">' + escapeHtml(node.text) + '</a>';
      case 'em': return '<em>' + renderChildren(node.children) + '</em>';
      case 'strong': return '<strong>' + renderChildren(node.children) + '</strong>';
      case 'del': return '<del>' + renderChildren(node.children) + '</del>';
      case 'link': {
        let out = '<a href="' + escapeAttr(node.href) + '"';
        if (node.title !== null && node.title !== undefined) out += ' title="' + escapeAttr(node.title) + '"';
        return out + '>' + renderChildren(node.children) + '</a>';
      }
      case 'image': {
        let out = '<img src="' + escapeAttr(node.href) + '" alt="' + escapeHtml(node.alt) + '"';
        if (node.title !== null && node.title !== undefined) out += ' title="' + escapeAttr(node.title) + '"';
        return out + '>';
      }
      default: return '';
    }
  }

  // ---- extended autolinks (GFM) -------------------------------------------

  // Match a domain starting at i: labels of [a-zA-Z0-9-] separated by '.',
  // each label starting and ending alphanumerically. Returns the end index
  // of the longest valid domain, or -1. The domain must contain a '.'.
  function scanDomain(src, i) {
    const n2 = src.length;
    let j = i;
    let dots = 0;
    let lastEnd = -1;
    while (true) {
      // one label
      if (j >= n2 || !isAlnum(src[j])) return lastEnd;
      let k = j;
      while (k < n2 && (isAlnum(src[k]) || src[k] === '-')) k++;
      if (src[k - 1] === '-') return -1; // a label may not end with '-',
        // and the whole domain is invalid (no truncating to a prefix)
      j = k;
      if (j < n2 && src[j] === '.') {
        dots++;
        j++;
        lastEnd = j - 1; // domain ends before this dot only if more follows
        continue;
      }
      lastEnd = j;
      break;
    }
    if (dots === 0) return -1;
    return lastEnd;
  }

  // True when an entity-like reference (&word;, &#123;, &#x1F;) starts
  // at src[j]. An extended autolink's path stops before one.
  function isEntityStart(src, j) {
    if (src[j] !== '&') return false;
    let k = j + 1;
    if (src[k] === '#') {
      k++;
      if (src[k] === 'x' || src[k] === 'X') k++;
      const start = k;
      while (k < src.length && isAlnum(src[k])) k++;
      return k > start && src[k] === ';';
    }
    const start = k;
    while (k < src.length && (isAlnum(src[k]))) k++;
    return k > start && src[k] === ';';
  }

  // Try an extended autolink at i (www., scheme://, scheme:email, email).
  // Returns {href, text, next} or null. `boundary` says the previous
  // character is start/whitespace/'('/'['.
  function tryExtAutolink(src, i) {
    const n2 = src.length;
    // www.
    if (src.startsWith('www.', i)) {
      const end = scanDomain(src, i + 4);
      if (end < 0) return null;
      // The character after the domain must not extend it.
      if (end < n2 && (isAlnum(src[end]) || src[end] === '-')) return null;
      let j = end;
      if (src[j] === '/') {
        while (j < n2 && !isSpace(src[j]) && src[j] !== '<' && !isEntityStart(src, j)) j++;
      }
      j = trimAutolinkEnd(src, i, j);
      if (j <= i + 4) return null;
      const text = src.slice(i, j);
      return { href: 'http://' + text, text, next: j };
    }
    // scheme: http:// https:// ftp:// or scheme:email/domain
    if (isAlpha(src[i])) {
      let k = i + 1;
      while (k < n2 && (isAlnum(src[k]) || src[k] === '+' || src[k] === '-' || src[k] === '.')) k++;
      if (k - i < 2 || k - i > 32 || src[k] !== ':') return tryEmail(src, i);
      const scheme = src.slice(i, k).toLowerCase();
      let j = k + 1;
      if (src.startsWith('//', j)) {
        const dEnd = scanDomain(src, j + 2);
        if (dEnd < 0) return tryEmail(src, i);
        if (dEnd < n2 && (isAlnum(src[dEnd]) || src[dEnd] === '-')) return tryEmail(src, i);
        j = dEnd;
        while (j < n2 && !isSpace(src[j]) && src[j] !== '<' && !isEntityStart(src, j)) j++;
        j = trimAutolinkEnd(src, i, j);
        const text = src.slice(i, j);
        return { href: text, text, next: j };
      }
      // scheme:email or scheme:domain
      const em = tryEmailAt(src, j);
      if (em) {
        let e = em.next;
        if (src[e] === '/') {
          // one path segment only
          let s = e + 1;
          while (s < n2 && !isSpace(src[s]) && src[s] !== '<' && src[s] !== '/') s++;
          if (s > e + 1) e = s;
        }
        e = trimAutolinkEnd(src, i, e);
        const text = src.slice(i, e);
        return { href: text, text, next: e };
      }
      // The email was invalid, and a domain cannot contain '@': if an
      // '@' follows before any path separator, this is a failed email,
      // not a domain, so no autolink forms at all.
      {
        let s = j;
        while (s < n2 && !isSpace(src[s]) && src[s] !== '<' && src[s] !== '/') s++;
        if (src.slice(j, s).includes('@')) return tryEmail(src, i);
      }
      const dEnd = scanDomain(src, j);
      if (dEnd >= 0) {
        if (dEnd < n2 && (isAlnum(src[dEnd]) || src[dEnd] === '-')) return tryEmail(src, i);
        let e = dEnd;
        while (e < n2 && !isSpace(src[e]) && src[e] !== '<' && !isEntityStart(src, e)) e++;
        e = trimAutolinkEnd(src, i, e);
        const text = src.slice(i, e);
        return { href: text, text, next: e };
      }
      return tryEmail(src, i);
    }
    return tryEmail(src, i);
  }

  // Try an email autolink starting at i (the start of the local part).
  function tryEmail(src, i) {
    const em = tryEmailAt(src, i);
    if (!em) return null;
    return { href: 'mailto:' + em.text, text: em.text, next: em.next };
  }

  // Match local@domain starting at i. Returns {text, next} or null.
  function tryEmailAt(src, i) {
    const n2 = src.length;
    let j = i;
    let at = -1;
    while (j < n2) {
      const c = src[j];
      if (isAlnum(c) || ".!#$%&'*+/=?^_`{|}~-".indexOf(c) !== -1) { j++; continue; }
      if (c === '@' && at < 0) { at = j; j++; continue; }
      break;
    }
    if (at < 0 || at === i) return null;
    const dEnd = scanDomain(src, at + 1);
    if (dEnd < 0) return null;
    // The character after the domain must not extend it.
    if (dEnd < n2 && (isAlnum(src[dEnd]) || src[dEnd] === '-' || src[dEnd] === '_' || src[dEnd] === '+')) return null;
    return { text: src.slice(i, dEnd), next: dEnd };
  }

  // Trim trailing punctuation and unbalanced ')' from an autolink
  // candidate [start, end).
  function trimAutolinkEnd(src, start, end) {
    let j = end;
    while (j > start) {
      const c = src[j - 1];
      if (c === '?' || c === '!' || c === '.' || c === ',' || c === ':' || c === '*' || c === '_' || c === '~') { j--; continue; }
      if (c === ';') {
        // Keep the ';' when it closes an entity reference.
        const amp = src.lastIndexOf('&', j - 1);
        if (amp >= start) {
          const el = entityLengthAt(src, amp);
          if (el > 0 && amp + el === j) break;
        }
        j--; continue;
      }
      if (c === ')') {
        let open = 0, close = 0;
        for (let k = start; k < j; k++) {
          if (src[k] === '(') open++;
          else if (src[k] === ')') close++;
        }
        if (close > open) { j--; continue; }
      }
      break;
    }
    return j;
  }

  // ---- link formation ------------------------------------------------------

  function tryFormLink(closerPos) {
    // Nearest active '[' or '![' delimiter.
    let opener = null;
    for (let d = dTail; d; d = d.prev) {
      if (d.type === 'bracket' && d.active) { opener = d; break; }
    }
    if (!opener) return false;
    let dest = null;
    let title = null;
    let next = closerPos + 1; // shortcut reference: continue after ']'
    const after = closerPos + 1;
    if (src[after] === '(') {
      const r = parseInlineLinkRest(src, after);
      if (r) { dest = r.dest; title = r.title; next = r.next; }
    }
    if (dest === null) {
      let label = null;
      if (src[after] === '[') {
        const r = scanBracketLabel(src, after);
        if (r) { label = r.label; next = r.next; }
      }
      if (label === null || label === '') {
        // Shortcut or collapsed reference: the label is the link text
        // itself, kept literally (backslash escapes are not processed
        // for matching, so [foo\!] does not match a [foo!] definition).
        label = src.slice(opener.pos + (opener.image ? 2 : 1), closerPos);
      }
      const norm = normalizeLabel(label);
      const ref = norm ? refs.get(norm) : undefined;
      if (ref) { dest = ref.dest; title = ref.title; }
    }
    if (dest === null) {
      // No link: the opener can pair with nothing later.
      removeDelim(opener);
      return false;
    }
    const href = cleanUrl(unescapePunct(dest));
    const cleanTitle = title === null ? null : unescapePunct(title);
    flushText();
    // Emphasis among the delimiters inside the link text is processed
    // first, while the nodes are still in the main list; every delimiter
    // after the opener in the stack is inside the link text.
    const inside = [];
    for (let d = opener.next; d; d = d.next) inside.push(d);
    if (inside.length) {
      processEmphasis(dTail, opener);
      for (const d of inside) {
        if (d.prev !== null || d.next !== null || dHead === d) removeDelim(d);
      }
    }
    // Collect the nodes between the opener and the end of the list (the
    // ']' itself is not a node): these become the link's children.
    // Extended autolinks inside link text stay links.
    const children = [];
    let cur = opener.node.next;
    while (cur !== null) {
      const nxt = cur.next;
      children.push(cur);
      cur.prev = null; cur.next = null;
      cur = nxt;
    }
    // A link may not contain another link: if the link text holds a
    // link node, this opener cannot form a link. (An image may hold a
    // link in its alt text, so images are exempt.)
    if (!opener.image) {
      const hasLink = (nodes) => nodes.some((nd) =>
        nd.t === 'link' || (nd.children && hasLink(nd.children)));
      if (hasLink(children)) {
        // Restore the children to the main list and drop the opener.
        let last = opener.node;
        for (const ch of children) { last.next = ch; ch.prev = last; last = ch; }
        tail = last;
        removeDelim(opener);
        return false;
      }
    }
    tail = opener.node;
    // (No deactivation of earlier '[' openers here: a link that would
    // contain an already-formed link is rejected by the nested-link
    // check above, and deactivating would hide the nearer opener from
    // a later ']', letting an outer image close at the wrong bracket.)
    const linkNode = opener.image
      ? { t: 'image', href, title: cleanTitle, alt: textOf(children), next: null, prev: null }
      : { t: 'link', href, title: cleanTitle, children, next: null, prev: null };
    // Splice the link node in where the opener was; the opener node and
    // every node after it (now the link's children) leave the main list.
    const prevNode = opener.node.prev;
    opener.node.next = null;
    opener.node.prev = null;
    if (prevNode) prevNode.next = linkNode;
    linkNode.prev = prevNode;
    linkNode.next = null;
    tail = linkNode;
    removeDelim(opener);
    // Advance the scanner past the link's closing ')' / label.
    scanPos = next;
    return true;
  }

  // Predict whether the nearest active bracket opener will form a link
  // when its ']' is reached, scanning forward from `fromPos`. Extended
  // autolinks do not form inside link text, so when the bracket will
  // form, the caller leaves the URL as plain text. Returns false when
  // the bracket will not form (no closer, no valid destination/label,
  // or the text already holds a link node).
  function bracketWillFormLink(opener, fromPos) {
    // Find the ']' closing this opener, skipping code spans and
    // tracking nested brackets.
    let depth = 0;
    let c = -1;
    let j = fromPos;
    while (j < n) {
      const ch2 = src[j];
      if (ch2 === '\\' && j + 1 < n) { j += 2; continue; }
      if (ch2 === '`') {
        let k = j;
        while (k < n && src[k] === '`') k++;
        const run = k - j;
        let found = -1;
        let m = k;
        while (m < n) {
          if (src[m] === '`') {
            let e = m;
            while (e < n && src[e] === '`') e++;
            if (e - m === run) { found = m; break; }
            m = e;
          } else m++;
        }
        if (found >= 0) { j = found + run; continue; }
        j = k; continue;
      }
      if (ch2 === '[') { depth++; j++; continue; }
      if (ch2 === ']') {
        if (depth === 0) { c = j; break; }
        depth--; j++; continue;
      }
      j++;
    }
    if (c < 0) return false;
    const after = c + 1;
    let dest = null;
    if (src[after] === '(') {
      const r = parseInlineLinkRest(src, after);
      if (r) dest = r.dest;
    }
    if (dest === null) {
      let label = null;
      if (src[after] === '[') {
        const r = scanBracketLabel(src, after);
        if (r) label = r.label;
      }
      if (label === null || label === '') {
        label = src.slice(opener.pos + (opener.image ? 2 : 1), c);
      }
      const norm = normalizeLabel(label);
      const ref = norm ? refs.get(norm) : undefined;
      if (ref) dest = ref.dest;
    }
    if (dest === null) return false;
    // A link may not contain another link (images exempt): if the text
    // already scanned holds a link node, this opener cannot form.
    if (!opener.image) {
      const hasLink = (nodes) => nodes.some((nd) =>
        nd.t === 'link' || (nd.children && hasLink(nd.children)));
      const scanned = [];
      let cur = opener.node.next;
      while (cur !== null) { scanned.push(cur); cur = cur.next; }
      if (hasLink(scanned)) return false;
    }
    return true;
  }

  // ---- main scan ------------------------------------------------------------

  let scanPos = 0;
  function isBoundaryBefore(i) {
    if (i === 0) return true;
    const c = src[i - 1];
    return isSpace(c) || c === '(' || c === '[' || c === '<';
  }

  while (scanPos < n) {
    const i = scanPos;
    const ch = src[i];

    if (ch === '\\') {
      const nx = src[i + 1];
      if (nx === '\n') {
        flushText();
        appendNode({ t: 'br', next: null, prev: null });
        // A hard break swallows the next line's leading whitespace.
        let j = i + 2;
        while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
        scanPos = j;
        continue;
      }
      if (nx !== undefined && isAsciiPunct(nx)) { buf += nx; scanPos = i + 2; continue; }
      buf += '\\';
      scanPos = i + 1;
      continue;
    }

    if (ch === '`') {
      let k = i;
      while (k < n && src[k] === '`') k++;
      const run = k - i;
      // Find a matching run of exactly `run` backticks.
      let found = -1;
      let j = k;
      while (j < n) {
        if (src[j] === '`') {
          let e = j;
          while (e < n && src[e] === '`') e++;
          if (e - j === run) { found = j; break; }
          j = e;
        } else j++;
      }
      if (found >= 0) {
        let content = src.slice(k, found).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        flushText();
        appendNode({ t: 'code', html: '<code>' + escapeHtml(content) + '</code>', plain: content, next: null, prev: null });
        scanPos = found + run;
        continue;
      }
      buf += '`'.repeat(run);
      scanPos = k;
      continue;
    }

    if (ch === '<') {
      // Autolink <scheme:...> or <email>, else inline HTML tag.
      const m = src.slice(i, i + 2048).match(/^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*)>/) ||
        src.slice(i, i + 2048).match(/^<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/);
      if (m) {
        flushText();
        const text = m[1];
        const href = text.indexOf(':') >= 0 && /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.test(text) ? text : 'mailto:' + text;
        appendNode({ t: 'autolink', href: cleanUrl(href), text, next: null, prev: null });
        scanPos = i + m[0].length;
        continue;
      }
      const tag = matchHtmlTag(src, i);
      if (tag) {
        flushText();
        const kind = htmlTagNameIsA(tag.text);
        if (kind === 'open') inLinkLeak = true;
        else if (kind === 'close') inLinkLeak = false;
        appendNode({ t: 'html', s: tag.text, next: null, prev: null });
        scanPos = tag.next;
        continue;
      }
      buf += '<';
      scanPos = i + 1;
      continue;
    }

    if (ch === '&') {
      const d = decodeNumericEntityAt(src, i);
      if (d) { buf += d[0]; scanPos = i + d[1]; continue; }
      const nl = matchNamedEntity(src, i);
      if (nl > 0) {
        // Named references pass through verbatim, even undefined ones.
        flushText();
        appendNode({ t: 'entity', s: src.slice(i, i + nl), next: null, prev: null });
        scanPos = i + nl;
        continue;
      }
      buf += '&';
      scanPos = i + 1;
      continue;
    }

    if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      flushText();
      const image = ch === '!';
      const node = { t: 'bracket', image, next: null, prev: null };
      appendNode(node);
      pushDelim({ type: 'bracket', image, active: true, node, pos: i, prev: null, next: null });
      scanPos = i + (image ? 2 : 1);
      continue;
    }

    if (ch === ']') {
      flushText();
      // The closer node is the node we just flushed (or the tail if the
      // buffer was empty and the last node is the closer's text).
      const formed = tryFormLink(i);
      if (formed) continue;
      // Not a link: the ']' is literal text.
      buf += ']';
      scanPos = i + 1;
      continue;
    }

    if (ch === '*' || ch === '_') {
      let k = i;
      while (k < n && src[k] === ch) k++;
      const run = k - i;
      const before = i > 0 ? src[i - 1] : '\n';
      const after = k < n ? src[k] : '\n';
      const beforeWs = isUnicodeWhitespace(before);
      const afterWs = isUnicodeWhitespace(after);
      const beforePunct = isPunct(before);
      const afterPunct = isPunct(after);
      const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
      const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
      let canOpen, canClose;
      if (ch === '*') { canOpen = leftFlanking; canClose = rightFlanking; }
      else {
        canOpen = leftFlanking && (!rightFlanking || beforePunct);
        canClose = rightFlanking && (!leftFlanking || afterPunct);
      }
      flushText();
      const node = { t: 'delim', ch, n: run, next: null, prev: null };
      appendNode(node);
      pushDelim({ type: 'em', ch, n: run, canOpen, canClose, node, pos: i, len: run, prev: null, next: null });
      scanPos = k;
      continue;
    }

    if (ch === '~') {
      let k = i;
      while (k < n && src[k] === '~') k++;
      const run = k - i;
      if (run === 1 || run === 2) {
        const before = i > 0 ? src[i - 1] : '\n';
        const after = k < n ? src[k] : '\n';
        const beforeWs = isUnicodeWhitespace(before);
        const afterWs = isUnicodeWhitespace(after);
        const beforePunct = isPunct(before);
        const afterPunct = isPunct(after);
        const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
        const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
        flushText();
        const node = { t: 'delim', ch: '~', n: run, next: null, prev: null };
        appendNode(node);
        pushDelim({ type: 'em', ch: '~', n: run, canOpen: leftFlanking, canClose: rightFlanking, node, pos: i, len: run, prev: null, next: null });
        scanPos = k;
        continue;
      }
      // A run of 3+ tildes is literal text, never a strikethrough
      // delimiter.
      buf += '~'.repeat(run);
      scanPos = k;
      continue;
    }

    if (ch === '\n') {
      // Hard break when the line ends with two or more spaces.
      let k = i - 1;
      let spaces = 0;
      while (k >= 0 && src[k] === ' ') { spaces++; k--; }
      if (spaces >= 2) {
        if (buf.length >= spaces) buf = buf.slice(0, buf.length - spaces);
        else buf = '';
        flushText();
        appendNode({ t: 'br', next: null, prev: null });
        // A hard break swallows the next line's leading whitespace.
        let j = i + 1;
        while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
        scanPos = j;
        continue;
      }
      buf += '\n';
      scanPos = i + 1;
      continue;
    }

    // Extended autolinks (GFM): only where one may start, and never
    // while the leaked in-link flag is set (an unclosed <a> above),
    // nor inside a bracket that will form a link (link text keeps the
    // URL as plain text).
    if (!inLinkLeak && isBoundaryBefore(i) && (isAlnum(ch))) {
      let inFormingBracket = false;
      for (let d = dTail; d; d = d.prev) {
        if (d.type === 'bracket' && d.active) {
          inFormingBracket = bracketWillFormLink(d, i);
          break;
        }
      }
      if (!inFormingBracket) {
      const a = tryExtAutolink(src, i);
      if (a) {
        flushText();
        appendNode({ t: 'autolink', href: cleanUrl(a.href), text: a.text, next: null, prev: null });
        scanPos = a.next;
        continue;
      }
      }
    }

    buf += ch;
    scanPos = i + 1;
  }
  flushText();

  // Emphasis for everything left at the top level.
  processEmphasis(dTail, null);

  let out = '';
  for (let node = root.next; node; node = node.next) out += renderNode(node);
  return out;
}

// Match an inline HTML tag at src[i] === '<'. Returns {text, next} or null.
function matchHtmlTag(src, i) {
  const n = src.length;
  const rest = src.slice(i, i + 512);
  // Abruptly-closed comments: <!--> and <!---> are complete comments.
  if (rest.startsWith('<!-->')) return { text: '<!-->', next: i + 5 };
  if (rest.startsWith('<!--->')) return { text: '<!--->', next: i + 6 };
  let m = rest.match(/^<!--(?:(?!-->)[\s\S])*?-->/);
  if (m) return { text: m[0], next: i + m[0].length };
  m = rest.match(/^<\?[\s\S]*?\?>/);
  if (m) return { text: m[0], next: i + m[0].length };
  m = rest.match(/^<![A-Za-z][^>]*>/);
  if (m) return { text: m[0], next: i + m[0].length };
  m = rest.match(/^<!\[CDATA\[[\s\S]*?\]\]>/);
  if (m) return { text: m[0], next: i + m[0].length };
  // Quoted attribute values may span lines. A closing tag may not
  // carry attributes.
  const attr = `(?:\\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\\s*=\\s*(?:[^ \\t\\n"'=<>\\\`]+|'[^']*'|"[^"]*"))?)*`;
  m = rest.match(new RegExp(`^<[A-Za-z][A-Za-z0-9-]*${attr}\\s*\\/?>`));
  if (m) return { text: m[0], next: i + m[0].length };
  m = rest.match(/^<\/[A-Za-z][A-Za-z0-9-]*\s*>/);
  if (m) return { text: m[0], next: i + m[0].length };
  return null;
}


// ------------------------------------------------------------ block parsing

// Expand leading tabs to spaces ONLY when the tab is partial (its
// width to the next tab stop is under 4 columns); a full-width tab
// stays a literal tab. Used for code-block content, where a tab at
// column 3 (width 1) becomes one space but a tab at column 0 stays.
function expandPartialTabs(s, startCol = 0) {
  let col = startCol;
  let i = 0;
  let out = '';
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) {
    if (s[i] === ' ') { out += ' '; col++; i++; }
    else {
      const next = (Math.floor(col / 4) + 1) * 4;
      const width = next - col;
      out += width === 4 ? '\t' : ' '.repeat(width);
      col = next;
      i++;
    }
  }
  return out + s.slice(i);
}

// Columns of leading whitespace, counting from `startCol`: a space is 1
// column, a tab advances to the next multiple of 4.
function indentCols(s, startCol = 0) {
  let col = startCol;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ' ') col++;
    else if (s[i] === '\t') col = (Math.floor(col / 4) + 1) * 4;
    else break;
  }
  return col - startCol;
}

// Expand a line's leading whitespace run to spaces, keeping the total
// width (tab stops taken from `startCol`).
function expandLeading(s, startCol = 0) {
  let col = startCol;
  let i = 0;
  let out = '';
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) {
    if (s[i] === ' ') { out += ' '; col++; i++; }
    else {
      const next = (Math.floor(col / 4) + 1) * 4;
      out += ' '.repeat(next - col);
      col = next;
      i++;
    }
  }
  return out + s.slice(i);
}

// Remove n columns of leading indentation (from `startCol`); a tab that
// straddles the boundary becomes spaces for its remainder, and the rest
// of the leading run is expanded to spaces at its original tab stops so
// that later strips stay additive.
function stripCols(s, n, startCol = 0) {
  let col = startCol;
  let i = 0;
  while (i < s.length && col - startCol < n) {
    const c = s[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') {
      const next = (Math.floor(col / 4) + 1) * 4;
      if (next - startCol <= n) { col = next; i++; }
      else return expandLeading(s, startCol).slice(n);
    } else break;
  }
  return s.slice(i);
}

function isBlankLine(s) {
  return /^[ \t]*$/.test(s);
}

// Labels match case-insensitively under Unicode case folding: the
// sharp s (ß, ẞ) folds to 'ss' and the final sigma (ς) to 'σ'.
function normalizeLabel(label) {
  return label.replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/ß/g, 'ss').replace(/ς/g, 'σ');
}

// Link reference definition parsing (used for paragraphs and setext
// headings). Operates on the paragraph text (lines joined with '\n').

function skipSpacesAndNewlines(text, i) {
  while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n')) i++;
  return i;
}

// A destination for a link reference definition: <...> or a bare one
// (no spaces or line endings, balanced parens). Empty is not allowed.
function scanDefDest(text, i) {
  const n = text.length;
  if (text[i] === '<') {
    let k = i + 1;
    let d = '';
    while (k < n) {
      const c = text[k];
      if (c === '\n' || c === '<') return null;
      if (c === '>') return { dest: d, next: k + 1 };
      if (c === '\\' && k + 1 < n && isAsciiPunct(text[k + 1])) { d += text[k + 1]; k += 2; continue; }
      d += c;
      k++;
    }
    return null;
  }
  let k = i;
  let d = '';
  let depth = 0;
  while (k < n) {
    const c = text[k];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') break;
    if (c.charCodeAt(0) < 32) break;
    if (c === '\\' && k + 1 < n && isAsciiPunct(text[k + 1])) { d += text[k + 1]; k += 2; continue; }
    if (c === '(') { depth++; d += c; k++; continue; }
    if (c === ')') {
      if (depth === 0) break;
      depth--; d += c; k++; continue;
    }
    d += c;
    k++;
  }
  if (d.length === 0) return null;
  return { dest: d, next: k };
}

// Parse one link reference definition at text[j] === '['. Returns
// {label, dest, title, next} (next just past the definition) or null.
function parseDefAt(text, j) {
  // Label: '[' ... ']' then ':'. A label may not contain a nested
  // '[' and may not normalize to empty (a label of only whitespace).
  let k = j + 1;
  let label = '';
  const n = text.length;
  while (k < n) {
    const c = text[k];
    if (c === '\\' && k + 1 < n && isAsciiPunct(text[k + 1])) { label += text[k] + text[k + 1]; k += 2; continue; }
    if (c === '[') return null;
    if (c === ']') break;
    label += c;
    k++;
    if (label.length > 999) return null;
  }
  if (k >= n || text[k] !== ']' || label.length === 0) return null;
  if (normalizeLabel(label) === '') return null;
  k++;
  if (text[k] !== ':') return null;
  k++;
  k = skipSpacesAndNewlines(text, k);
  const d = scanDefDest(text, k);
  if (!d) return null;
  k = d.next;
  let title = null;
  // Optional title: it must be separated from the destination by
  // whitespace (space, tab, or newline), and the rest of the title's
  // line must be blank. A malformed title does not kill the definition:
  // the definition stands without a title and the title-looking text
  // stays as paragraph content.
  const k2 = skipSpacesAndNewlines(text, k);
  if ((text[k2] === '"' || text[k2] === "'" || text[k2] === '(') && k2 > k) {
    const t = scanDefTitle(text, k2);
    if (t) {
      let e = t.next;
      while (e < n && (text[e] === ' ' || text[e] === '\t')) e++;
      if (e >= n || text[e] === '\n') {
        title = t.title;
        k = e;
      }
    }
  }
  if (title === null) {
    // No title: the rest of the destination's line must be blank.
    let e = k;
    while (e < n && (text[e] === ' ' || text[e] === '\t')) e++;
    if (e < n && text[e] !== '\n') return null;
    k = e;
  }
  return { label, dest: d.dest, title, next: k };
}

function scanDefTitle(text, i) {
  const n = text.length;
  const q = text[i];
  if (q === '"' || q === "'") {
    let k = i + 1;
    let t = '';
    while (k < n) {
      const c = text[k];
      if (c === q) return { title: t, next: k + 1 };
      if (c === '\\' && k + 1 < n && isAsciiPunct(text[k + 1])) { t += text[k + 1]; k += 2; continue; }
      t += c;
      k++;
    }
    return null;
  }
  if (q === '(') {
    let k = i + 1;
    let t = '';
    let depth = 1;
    while (k < n) {
      const c = text[k];
      if (c === '\\' && k + 1 < n && isAsciiPunct(text[k + 1])) { t += text[k + 1]; k += 2; continue; }
      if (c === '(') { depth++; t += c; k++; continue; }
      if (c === ')') {
        depth--;
        if (depth === 0) return { title: t, next: k + 1 };
        t += c; k++; continue;
      }
      t += c;
      k++;
    }
    return null;
  }
  return null;
}

// Strip leading link reference definitions from a paragraph's joined
// text, recording them in refs (first definition wins). Returns the
// remaining text.
function extractLinkDefs(text, refs) {
  let pos = 0;
  const n = text.length;
  let any = false;
  while (pos < n) {
    let j = pos;
    let spaces = 0;
    while (j < n && text[j] === ' ' && spaces < 3) { j++; spaces++; }
    if (text[j] !== '[') break;
    const def = parseDefAt(text, j);
    if (!def) break;
    const norm = normalizeLabel(def.label);
    if (norm && !refs.has(norm)) refs.set(norm, { dest: def.dest, title: def.title });
    pos = def.next;
    any = true;
    if (text[pos] === '\n') pos++;
    else if (pos < n) break;
  }
  return any ? text.slice(pos) : text;
}

// ---- GFM tables ------------------------------------------------------------

// Split a table row on unescaped pipes that are not inside code spans.
// Returns the cell strings, or null when the row has no cells.
function splitTableRow(row) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = row.length;
  let inCode = 0; // length of the open code run, 0 when not in one
  while (i < n) {
    const c = row[i];
    // An escaped pipe does not split the cell, and the backslash is
    // dropped here (before inline parsing), so `\|` inside a code
    // span still renders as a bare '|'.
    if (c === '\\' && i + 1 < n && row[i + 1] === '|') { cur += '|'; i += 2; continue; }
    if (c === '`') {
      let k = i;
      while (k < n && row[k] === '`') k++;
      const run = k - i;
      if (inCode === 0) {
        // Only open a code span when a matching closing run exists;
        // an unmatched backtick is literal text and must not stop
        // later pipes from splitting the row.
        let j = k;
        let found = false;
        while (j < n) {
          if (row[j] === '`') {
            let e = j;
            while (e < n && row[e] === '`') e++;
            if (e - j === run) { found = true; break; }
            j = e;
          } else j++;
        }
        if (found) inCode = run;
      } else if (inCode === run) inCode = 0;
      cur += row.slice(i, k);
      i = k;
      continue;
    }
    if (c === '|' && inCode === 0) {
      cells.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  cells.push(cur);
  // Drop a leading empty cell (leading pipe) and a trailing one.
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells;
}

// Try to read a table from a paragraph's lines. Returns the table node or null.
function tryTable(lines) {
  if (lines.length < 2) return null;
  // The delimiter row must not be indented four or more spaces.
  if (indentCols(lines[1]) > 3) return null;
  const header = splitTableRow(lines[0]);
  const delim = splitTableRow(lines[1]);
  if (!header.length || header.length !== delim.length) return null;
  const aligns = [];
  for (let i = 0; i < delim.length; i++) {
    const cell = delim[i].trim();
    if (!/^:?-+:?$/.test(cell)) return null;
    aligns.push(cell.startsWith(':') ? (cell.endsWith(':') ? 'center' : 'left') : (cell.endsWith(':') ? 'right' : null));
  }
  const rows = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = splitTableRow(lines[i]);
    while (cells.length < header.length) cells.push('');
    if (cells.length > header.length) cells.length = header.length;
    rows.push(cells.map((c) => c.trim()));
  }
  return {
    type: 'table',
    header: header.map((c) => c.trim()),
    aligns,
    rows,
  };
}

// ---- block-level line checks -----------------------------------------------

function isSetextLine(s) {
  const m = /^ {0,3}(=+|-+)[ \t]*$/.exec(s);
  return m ? (m[1][0] === '=' ? 1 : 2) : 0;
}

function isThematicBreak(s) {
  return /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(s);
}

function parseAtx(s) {
  const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(s);
  if (!m) return null;
  let content = (m[2] || '').replace(/[ \t]+$/, '');
  content = content.replace(/[ \t]+#+$/, '').replace(/^#+$/, '');
  return { level: m[1].length, content: content.replace(/[ \t]+$/, '') };
}

function parseFence(s) {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(s);
  if (!m) return null;
  if (m[1][0] === '`' && m[2].indexOf('`') !== -1) return null;
  return { ch: m[1][0], len: m[1].length, indent: indentCols(s), info: m[2].trim() };
}

const HTML_BLOCK_TAGS = new Set(
  'address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul'.split(' ')
);

// Returns {kind, end} for an HTML block start, or null. kind 1-6 can
// interrupt a paragraph; kind 7 cannot. `end` names how the block ends.
// A complete open or closing tag (no '<' inside attribute values).
// `rest` here already has the leading '<' stripped. A closing tag
// may not carry attributes.
const COMPLETE_OPEN_TAG = /^[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:"[^"<]*"|'[^'<]*'|[^\s"'=<>`]+))?)*[ \t]*\/?>/;
const COMPLETE_CLOSE_TAG = /^\/[A-Za-z][A-Za-z0-9-]*[ \t]*>/;

// Does this line end an HTML block of the given kind? Kind 1 ends at
// its closing tag; kinds 2-5 end at their end marker.
function htmlLineEnds(kind, end, line) {
  if (kind === 1) {
    return new RegExp('</' + end + '[\\s>/]', 'i').test(line) || new RegExp('</' + end + '$', 'i').test(line);
  }
  if (kind >= 2 && kind <= 5) return line.indexOf(end) !== -1;
  return false;
}

function htmlBlockStart(s) {
  const m = /^ {0,3}</.exec(s);
  if (!m) return null;
  const rest = s.slice(m[0].length);
  // Type 1: an opening <script, <pre, <style or <textarea tag only.
  let mm = /^(script|pre|style|textarea)(?:[ \t>]|$)/i.exec(rest);
  if (mm) return { kind: 1, end: mm[1].toLowerCase() };
  if (rest.startsWith('!--')) return { kind: 2, end: '-->' };
  if (rest.startsWith('?')) return { kind: 3, end: '?>' };
  if (/^![A-Za-z]/.test(rest)) return { kind: 4, end: '>' };
  if (rest.startsWith('![CDATA[')) return { kind: 5, end: ']]>' };
  mm = /^(\/?)([A-Za-z][A-Za-z0-9-]*)(?:[ \t/>]|$)/.exec(rest);
  if (mm && HTML_BLOCK_TAGS.has(mm[2].toLowerCase())) return { kind: 6, end: 'blank' };
  // Type 7: a complete open or closing tag, alone on the line.
  const tag = COMPLETE_OPEN_TAG.exec(rest) || COMPLETE_CLOSE_TAG.exec(rest);
  if (tag && /^[ \t]*$/.test(rest.slice(tag[0].length))) return { kind: 7, end: 'blank' };
  return null;
}

function parseListMarker(s, startCol = 0) {
  const m = /^ {0,3}([*+-]|\d{1,9}[.)])/.exec(s);
  if (!m) return null;
  const marker = m[1];
  const markerEnd = m[0].length;
  // The marker must be followed by a space, a tab, or the end of the line.
  if (markerEnd < s.length && s[markerEnd] !== ' ' && s[markerEnd] !== '\t') return null;
  let k = markerEnd;
  let col = startCol + markerEnd;
  while (k < s.length && (s[k] === ' ' || s[k] === '\t')) {
    if (s[k] === ' ') col++;
    else col = (Math.floor(col / 4) + 1) * 4;
    k++;
  }
  const ordered = marker[0] >= '0' && marker[0] <= '9';
  const base = {
    marker,
    ordered,
    bulletChar: ordered ? null : marker,
    delimChar: ordered ? marker[marker.length - 1] : null,
    startNum: ordered ? parseInt(marker.slice(0, -1), 10) : null,
  };
  const wsStart = startCol + markerEnd;
  if (k >= s.length) {
    return { ...base, contentIndent: wsStart + 1, content: '', empty: true };
  }
  const spacesCols = col - wsStart;
  if (spacesCols >= 1 && spacesCols <= 4) {
    return { ...base, contentIndent: col, content: s.slice(k), empty: false };
  }
  // Five or more columns of whitespace: the content starts one column in.
  return { ...base, contentIndent: wsStart + 1, content: stripCols(s.slice(markerEnd), 1, wsStart), empty: false };
}

// Can this line start a block that interrupts a paragraph?
function canInterruptParagraph(s) {
  if (parseAtx(s)) return true;
  if (parseFence(s)) return true;
  const h = htmlBlockStart(s);
  if (h && h.kind <= 6) return true;
  if (isThematicBreak(s)) return true;
  if (/^ {0,3}>/.test(s)) return true;
  const li = parseListMarker(s);
  // An empty list item cannot interrupt a paragraph.
  if (li && !li.empty && (!li.ordered || li.startNum === 1)) return true;
  return false;
}

// ---- the block parser -------------------------------------------------------

function parseBlocks(lines, refs) {
  const doc = { type: 'doc', children: [] };
  const stack = [{ type: 'doc', node: doc }];

  function top() { return stack[stack.length - 1]; }
  // Set at the top of each line iteration; see the for loop below.
  let nextLineBlank = false;
  function deepestContainer() {
    for (let k = stack.length - 1; k >= 0; k--) {
      const e = stack[k];
      if (e.type === 'doc' || e.type === 'blockquote' || e.type === 'list' || e.type === 'item') return e;
    }
    return stack[0];
  }
  function addChild(node) {
    let container = deepestContainer();
    if (container.type === 'list') {
      // A list's only children are items; a new non-item block ends the
      // list, so close it and add the block to the list's parent.
      const idx = stack.indexOf(container);
      stack.splice(idx, 1);
      container = stack[idx - 1];
    }
    container.node.children.push(node);
    // A blank line before this block inside a list item makes the list
    // loose, but only when the item already has a block: a blank line
    // before the item's first block does not loosen it.
    if (container.type === 'item' && container.node.blankAfter) {
      const idx = stack.indexOf(container);
      const listEntry = stack[idx - 1];
      if (container.node.children.length > 0 && listEntry && listEntry.type === 'list') listEntry.node.loose = true;
      container.node.blankAfter = false;
    }
    // A blank line inside an ancestor item is spent once new content is
    // added inside that item (as a descendant): it no longer separates
    // the ancestor item from its next sibling.
    for (let k = stack.indexOf(container) - 1; k >= 0; k--) {
      if (stack[k].type === 'item') stack[k].node.blankAfter = false;
    }
  }
  function removeFromParent(node) {
    const parent = deepestContainer().node;
    const idx = parent.children.indexOf(node);
    if (idx >= 0) parent.children.splice(idx, 1);
  }

  function closeParagraph(e) {
    const node = e.node;
    const joined = node.lines.join('\n');
    const rest = extractLinkDefs(joined, refs);
    if (rest.replace(/[ \t\n]/g, '') === '') {
      removeFromParent(node);
      return;
    }
    const restLines = rest.split('\n');
    const table = tryTable(restLines);
    if (table) {
      const parent = deepestContainer().node;
      const idx = parent.children.indexOf(node);
      if (idx >= 0) parent.children[idx] = table;
      return;
    }
    node.text = rest;
  }

  function closeLeaf() {
    const e = stack.pop();
    if (e.type === 'paragraph') closeParagraph(e);
    else if (e.type === 'code') {
      const lines2 = e.node.lines;
      if (e.fenced) {
        // A fenced code block drops exactly one trailing empty line
        // (the line terminator before the closing fence).
        if (lines2.length && lines2[lines2.length - 1] === '') lines2.pop();
      } else {
        // An indented code block drops all trailing blank lines.
        while (lines2.length && lines2[lines2.length - 1] === '') lines2.pop();
      }
      e.node.text = lines2.join('\n') + (lines2.length ? '\n' : '');
    }
    // html blocks need no finalizing
  }

  function closeFrom(k) {
    while (stack.length > k) closeLeaf();
  }

  function startParagraph(line) {
    const node = { type: 'paragraph', lines: [line] };
    addChild(node);
    stack.push({ type: 'paragraph', node });
  }

  // Setext heading level (1 or 2) of a line, or 0.
  function setextLevel(s, col) {
    const ind = indentCols(s, col);
    if (ind > 3) return 0;
    const t = stripCols(s, ind, col);
    const m = /^(=+|-+)[ \t]*$/.exec(t);
    return m ? (m[1][0] === '=' ? 1 : 2) : 0;
  }

  function isHrLine(s, col) {
    const ind = indentCols(s, col);
    if (ind > 3) return false;
    const t = stripCols(s, ind, col);
    return /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(t);
  }

  // Can this line start a block that interrupts a paragraph?
  function canInterruptParagraph(s, col) {
    const ind = indentCols(s, col);
    if (ind > 3) return false;
    const t = stripCols(s, ind, col);
    if (parseAtx(t)) return true;
    if (parseFence(t)) return true;
    const h = htmlBlockStart(t);
    if (h && h.kind <= 6) return true;
    if (isHrLine(s, col)) return true;
    if (t.startsWith('>')) return true;
    const li = parseListMarker(t, col + ind);
    // A non-empty bullet, or a non-empty ordered item starting at 1,
    // can interrupt a paragraph. Any marker (even empty, or ordered
    // with another start or delimiter) can interrupt when a list is
    // already open: it is a new item or a new sibling list.
    if (li && !li.empty && (!li.ordered || li.startNum === 1)) return true;
    if (li) {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].type === 'list') return true;
      }
    }
    return false;
  }

  // Convert an open paragraph to a setext heading in place. Returns
  // false when the paragraph is empty after link definitions are
  // extracted (then it is not a heading at all).
  function convertParagraphToHeading(e, level) {
    const node = e.node;
    const joined = node.lines.join('\n');
    const rest = extractLinkDefs(joined, refs);
    const text = rest.replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '');
    if (text === '') {
      // No heading: drop the (empty) paragraph; the underline line is
      // left for the caller to handle as a new paragraph.
      stack.pop();
      const parent = stack[stack.length - 1];
      const arr = parent.node.children || parent.node.items;
      const idx = arr.indexOf(node);
      if (idx >= 0) arr.splice(idx, 1);
      return false;
    }
    node.type = 'heading';
    node.level = level;
    node.text = text;
    delete node.lines;
    stack.pop();
    return true;
  }

  // The current remaining line and its absolute column (updated by
  // tryStartBlock when it pushes a container).
  let cur = '';
  let curCol = 0;

  // Try to start a new block with line `s` at absolute column `col`.
  // `inParagraph` says a paragraph is open. Returns 'container' (a
  // blockquote/list item was pushed and `cur`/`curCol` hold the
  // remainder), 'leaf' (the line was consumed), or 'none'.
  function tryStartBlock(s, inParagraph, col) {
    const ind = indentCols(s, col);
    // Indented code: only when no paragraph is open and indent >= 4.
    if (!inParagraph && ind >= 4) {
      const node = { type: 'code', fenced: false, info: '', lines: [stripCols(s, 4, col)] };
      addChild(node);
      stack.push({ type: 'code', node, fenced: false });
      return 'leaf';
    }
    if (ind > 3) return 'none';
    const t = stripCols(s, ind, col);
    const tCol = col + ind;
    const atx = parseAtx(t);
    if (atx) {
      const node = { type: 'heading', level: atx.level, text: atx.content };
      addChild(node);
      return 'leaf';
    }
    const fence = parseFence(t);
    if (fence) {
      const node = { type: 'code', fenced: true, info: fence.info, lines: [] };
      addChild(node);
      stack.push({ type: 'code', node, fenced: true, fenceCh: fence.ch, fenceLen: fence.len, fenceIndent: ind });
      return 'leaf';
    }
    const html = htmlBlockStart(t);
    if (html && (html.kind <= 6 || !inParagraph)) {
      // The first line keeps its leading whitespace (up to three spaces).
      const node = { type: 'html', kind: html.kind, lines: [s] };
      addChild(node);
      stack.push({ type: 'html', node, end: html.end, kind: html.kind });
      // A kind 1-5 block can already end on its first line.
      if (htmlLineEnds(html.kind, html.end, s)) {
        node.noTrailingNl = nextLineBlank;
        stack.pop();
      }
      return 'leaf';
    }
    if (isHrLine(s, col)) {
      addChild({ type: 'hr' });
      return 'leaf';
    }
    const li = parseListMarker(t, tCol);
    if (li && (!inParagraph || !li.ordered || li.startNum === 1)) {
      // Find or create the list in the current container.
      let container = deepestContainer();
      let listNode = null;
      if (container.type === 'list') {
        const ln = container.node;
        if (ln.ordered === li.ordered &&
          (li.ordered ? ln.delimChar === li.delimChar : ln.bulletChar === li.bulletChar)) {
          listNode = ln;
        } else {
          // A different kind of list: close this one and use its parent.
          closeLeaf();
          container = deepestContainer();
        }
      }
      if (!listNode) {
        const kids = container.node.children;
        if (kids.length) {
          const last = kids[kids.length - 1];
          if (last.type === 'list' && last.ordered === li.ordered &&
            (li.ordered ? last.delimChar === li.delimChar : last.bulletChar === li.bulletChar)) {
            listNode = last;
          }
        }
      }
      if (!listNode) {
        listNode = {
          type: 'list', ordered: li.ordered, start: li.startNum ?? 1,
          bulletChar: li.bulletChar, delimChar: li.delimChar,
          loose: false, items: [],
        };
        addChild(listNode);
        stack.push({ type: 'list', node: listNode });
      }
      // A blank line after the previous item makes the list loose.
      const items = listNode.items;
      if (items.length) {
        const prevItem = items[items.length - 1];
        if (prevItem.blankAfter) { listNode.loose = true; prevItem.blankAfter = false; }
      }
      const itemNode = { type: 'item', children: [], task: null, blankAfter: false };
      if (!li.empty) {
        const taskM = /^(\[[ xX]\])(?:[ \t]|$)/.exec(li.content);
        if (taskM) {
          itemNode.task = taskM[1][1] === ' ' ? false : true;
          // Keep everything after the checkbox, including the space,
          // so the checkbox is followed by ' foo'.
          li.content = li.content.slice(3);
          li.empty = li.content === '';
        }
      }
      listNode.items.push(itemNode);
      // minIndent: the indent a continuation line needs, measured from
      // the start of the line's container content area. It is the
      // content column minus the column where this line's content area
      // starts, so it stays correct when blockquote prefixes differ in
      // width from line to line.
      stack.push({ type: 'item', node: itemNode, contentIndent: li.contentIndent, minIndent: li.contentIndent - col, blankAfter: false });
      if (li.empty) return 'leaf';
      cur = li.content;
      curCol = tCol + (t.length - li.content.length) + (li.contentIndent - tCol);
      // The content's absolute column: the marker end plus the whitespace
      // consumed, i.e. the item's content indent.
      curCol = li.contentIndent;
      return 'container';
    }
    if (t.startsWith('>')) {
      const node = { type: 'blockquote', children: [] };
      addChild(node);
      stack.push({ type: 'blockquote', node });
      let rest = t.slice(1);
      let rCol = tCol + 1;
      if (rest[0] === ' ') { rest = rest.slice(1); rCol++; }
      else if (rest[0] === '\t') { rest = '   ' + rest.slice(1); rCol++; }
      cur = rest;
      curCol = rCol;
      return 'container';
    }
    return 'none';
  }

  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    // Whether the line after this one is blank: an HTML block of kind
    // 1-5 that ends here loses its trailing newline when a blank line
    // follows it.
    nextLineBlank = ln + 1 < lines.length && isBlankLine(lines[ln + 1]);
    if (isBlankLine(line)) {
      const t = top();
      // Whether a blockquote is open: a raw blank line closes it (and
      // everything inside it); a list is not closed by a blank line.
      let bqIdx = -1;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].type === 'blockquote') { bqIdx = k; break; }
      }
      if (t.type === 'html' && t.kind < 6) {
        // HTML blocks of kinds 1-5 run to their end marker: a blank
        // line joins the block and closes no container.
        t.node.lines.push(line);
      } else if (bqIdx >= 0) {
        closeFrom(bqIdx);
      } else if (t.type === 'paragraph') {
        closeLeaf();
      } else if (t.type === 'code') {
        // A blank line in a code block keeps its whitespace past the
        // block's indent (four columns for indented code, the fence's
        // indent for fenced code).
        t.node.lines.push(stripCols(line, t.fenced ? (t.fenceIndent || 0) : 4, 0));
      } else if (t.type === 'html') {
        // Only kinds 6 and 7 end at a blank line.
        closeLeaf();
      }
      // A blank line inside a list item: remember it for tight/loose.
      // (Not for blank lines that belong to a code block's content.)
      const codeContent = t.type === 'code' && bqIdx < 0;
      if (!codeContent) {
        for (let k = stack.length - 1; k >= 0; k--) {
          if (stack[k].type === 'item') stack[k].node.blankAfter = true;
        }
      }
      continue;
    }

    // Match the open containers against this line, tracking the absolute
    // column of the remaining text.
    let s = line;
    let col = 0;
    let failedAt = -1;
    let failStrip = 0; // leading whitespace consumed before the failed match
    for (let k = 1; k < stack.length; k++) {
      const e = stack[k];
      if (e.type === 'blockquote') {
        const ind = indentCols(s, col);
        if (ind <= 3) {
          const t2 = stripCols(s, ind, col);
          if (t2[0] === '>') {
            col += ind + 1;
            s = t2.slice(1);
            // The optional space after '>': one column, even of a tab.
            if (s[0] === ' ') { s = s.slice(1); col++; }
            else if (s[0] === '\t') { s = '   ' + s.slice(1); col++; }
            continue;
          }
        }
        failStrip = ind;
        failedAt = k;
        break;
      }
      if (e.type === 'item') {
        // A blank line is inside the item: the item stays open.
        if (s === '') continue;
        // An empty item followed by a blank line is closed: indented
        // lines after the blank line are not part of it.
        if (e.node.children.length === 0 && e.node.blankAfter) {
          failStrip = indentCols(s, col);
          failedAt = k;
          break;
        }
        // A continuation line belongs to the item when its indent,
        // measured from the container content area's start (col),
        // reaches the item's minimum indent.
        if (indentCols(s, col) >= e.minIndent) {
          s = stripCols(s, e.minIndent, col);
          col = col + e.minIndent;
          continue;
        }
        // Inside a fenced code block, a line is code content even when
        // it is not indented to the item's content level: the block
        // runs to its closing fence, so do not close the item (or the
        // code block) for such a line.
        const t0 = stack[stack.length - 1];
        if (t0.type === 'code' && t0.fenced) continue;
        failStrip = indentCols(s, col);
        failedAt = k;
        break;
      }
      if (e.type === 'list') continue;
      break; // a leaf block: no container matching below it
    }

    // A line that is empty after its containers matched is a blank
    // line inside those containers: it ends the open paragraph (or
    // code/html block) but the containers stay open. A whitespace-only
    // remainder is NOT blank: it joins the paragraph as a line of spaces.
    if (s === '') {
      if (failedAt >= 0) closeFrom(failedAt);
      const t2 = top();
      if (t2.type === 'paragraph') closeLeaf();
      else if (t2.type === 'code') t2.node.lines.push('');
      else if (t2.type === 'html') {
        if (t2.kind >= 6) closeLeaf();
        else t2.node.lines.push(line);
      }
      // The blank line is directly in a list item only when the item is
      // the innermost container left open; inside a blockquote it does
      // not loosen the item's list.
      const t3 = top();
      if (t3.type === 'item') t3.node.blankAfter = true;
      continue;
    }

    if (failedAt >= 0) {
      const t = top();
      if (t.type === 'paragraph') {
        if (!canInterruptParagraph(s, col)) {
          // Lazy continuation: the line joins the paragraph. Its leading
          // whitespace is stripped up to the amount the failed container
          // match consumed; a level-1 setext underline that cannot
          // convert the paragraph is indented four spaces instead.
          let lazy = stripCols(s, failStrip, col);
          if (setextLevel(lazy, 0) === 1) lazy = '    ' + lazy;
          t.node.lines.push(lazy);
          continue;
        }
      }
      closeFrom(failedAt);
    }

    // Start new blocks with the remaining line, possibly several.
    cur = s;
    curCol = col;
    while (true) {
      const t = top();
      if (t.type === 'paragraph') {
        const setext = setextLevel(cur, curCol);
        if (setext) {
          // An empty paragraph (only link definitions) is dropped and
          // the underline becomes a paragraph of its own.
          if (convertParagraphToHeading(t, setext)) break;
          continue;
        }
        if (canInterruptParagraph(cur, curCol)) {
          closeLeaf(); // the paragraph ends; retry with it closed
          continue;
        }
        t.node.lines.push(cur);
        break;
      }
      if (t.type === 'code' && t.fenced) {
        // A fenced code block: check for the closing fence.
        const ind = indentCols(cur, curCol);
        let closed = false;
        if (ind <= 3) {
          const t2 = stripCols(cur, ind, curCol);
          const m = /^(`{3,}|~{3,})[ \t]*$/.exec(t2);
          if (m && m[1][0] === t.fenceCh && m[1].length >= t.fenceLen) closed = true;
        }
        if (closed) { closeLeaf(); break; }
        // Strip the fence indent, then expand a leading partial tab
        // to spaces at its absolute tab stop.
        t.node.lines.push(expandPartialTabs(stripCols(cur, t.fenceIndent, curCol), curCol + t.fenceIndent));
        break;
      }
      if (t.type === 'code' && !t.fenced) {
        // Indented code: a line with indent >= 4 continues it.
        if (indentCols(cur, curCol) >= 4) {
          t.node.lines.push(expandPartialTabs(stripCols(cur, 4, curCol), curCol + 4));
          break;
        }
        closeLeaf();
        continue;
      }
      if (t.type === 'html') {
        t.node.lines.push(cur);
        if (htmlLineEnds(t.kind, t.end, cur)) {
          t.node.noTrailingNl = nextLineBlank;
          closeLeaf();
        }
        // Kinds 6 and 7 end at a blank line, handled by the blank-line
        // branch above.
        break;
      }
      // After a container was started, the line may be empty: it is a
      // blank line within that container, not a paragraph.
      if (cur === '') break;
      const started = tryStartBlock(cur, false, curCol);
      if (started === 'container') continue;
      if (started === 'leaf') break;
      startParagraph(cur);
      break;
    }
  }

  while (stack.length > 1) closeLeaf();
  return doc;
}

// ---- rendering ---------------------------------------------------------------

function renderBlock(b, refs, tightList) {
  switch (b.type) {
    case 'paragraph':
      return '<p>' + parseInline(b.text, refs) + '</p>\n';
    case 'heading':
      return '<h' + b.level + '>' + parseInline(b.text, refs) + '</h' + b.level + '>\n';
    case 'code': {
      let out = '<pre><code';
      if (b.fenced && b.info) {
        const lang = unescapePunct(b.info.split(/\s+/)[0]);
        out += ' class="language-' + escapeAttr(lang) + '"';
      }
      return out + '>' + escapeHtml(b.text) + '</code></pre>\n';
    }
    case 'html':
      // Kinds 1-5 keep the newline after their closing line, unless a
      // blank line follows the block; kinds 6 and 7 keep one only when
      // they run to the end of the input (trailingNl on the last leaf).
      return b.lines.join('\n') + ((b.kind <= 5 && !b.noTrailingNl) || b.trailingNl ? '\n' : '');
    case 'hr':
      return '<hr>\n';
    case 'blockquote': {
      let out = '<blockquote>\n';
      for (const c of b.children) out += renderBlock(c, refs, false);
      return out + '</blockquote>\n';
    }
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      let out = '<' + tag;
      if (b.ordered && b.start !== 1) out += ' start="' + b.start + '"';
      out += '>\n';
      for (const item of b.items) out += renderItem(item, refs, b.loose);
      return out + '</' + tag + '>\n';
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let i = 0; i < b.header.length; i++) {
        const a = b.aligns[i];
        out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + parseInline(b.header[i], refs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (b.rows.length) {
        out += '<tbody>';
        for (const row of b.rows) {
          out += '<tr>\n';
          for (let i = 0; i < row.length; i++) {
            const a = b.aligns[i];
            out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + parseInline(row[i], refs) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
    default:
      return '';
  }
}

function renderItem(item, refs, loose) {
  const checkbox = item.task === null ? '' :
    item.task ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">';
  let out = '<li>';
  for (let i = 0; i < item.children.length; i++) {
    const child = item.children[i];
    if (child.type === 'paragraph' && !loose) {
      out += (i === 0 ? checkbox : '') + parseInline(child.text, refs);
    } else if (child.type === 'paragraph') {
      out += '<p>' + (i === 0 ? checkbox : '') + parseInline(child.text, refs) + '</p>\n';
    } else {
      out += (i === 0 ? checkbox : '') + renderBlock(child, refs, false);
    }
  }
  if (!item.children.length) out += checkbox;
  return out + '</li>\n';
}

// ---- entry point ---------------------------------------------------------------

export function parse(markdown) {
  inLinkLeak = false;
  const src = String(markdown).replace(/\r\n?/g, '\n');
  let lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const refs = new Map();
  const doc = parseBlocks(lines, refs);
  // A kind 6/7 HTML block that runs to the end of the input keeps the
  // newline after its last line: mark the document's last leaf.
  if (src.endsWith('\n')) {
    let node = doc;
    while (true) {
      if (node.type === 'list') {
        if (!node.items.length) break;
        node = node.items[node.items.length - 1];
      } else if (node.children && node.children.length) {
        node = node.children[node.children.length - 1];
      } else break;
    }
    if (node.type === 'html' && (node.kind === 6 || node.kind === 7)) node.trailingNl = true;
  }
  let out = '';
  for (const b of doc.children) out += renderBlock(b, refs, false);
  return out;
}
