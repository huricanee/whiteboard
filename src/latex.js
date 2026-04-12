/**
 * LaTeX rendering utilities.
 *
 * Parses text for $...$ (inline) and $$...$$ (block) math segments,
 * renders them with KaTeX, and returns HTML.
 */
import katex from 'katex';

/**
 * Check if text contains any LaTeX delimiters.
 */
export function hasLatex(text) {
  return text && (text.includes('$'));
}

/**
 * Parse text into segments of plain text and math.
 * Returns array of { type: 'text'|'math'|'display', content: string }
 *
 * $$...$$ = display math (block)
 * $...$   = inline math
 * Escaped \$ is treated as literal $.
 */
export function parseLatex(text) {
  if (!text) return [{ type: 'text', content: '' }];

  const segments = [];
  let i = 0;
  let current = '';

  while (i < text.length) {
    // Escaped dollar
    if (text[i] === '\\' && text[i + 1] === '$') {
      current += '$';
      i += 2;
      continue;
    }

    // Display math $$...$$
    if (text[i] === '$' && text[i + 1] === '$') {
      if (current) segments.push({ type: 'text', content: current });
      current = '';
      i += 2;
      const start = i;
      while (i < text.length - 1 && !(text[i] === '$' && text[i + 1] === '$')) i++;
      segments.push({ type: 'display', content: text.slice(start, i) });
      if (i < text.length - 1) i += 2; // skip closing $$
      continue;
    }

    // Inline math $...$
    if (text[i] === '$') {
      if (current) segments.push({ type: 'text', content: current });
      current = '';
      i += 1;
      const start = i;
      while (i < text.length && text[i] !== '$') i++;
      segments.push({ type: 'math', content: text.slice(start, i) });
      if (i < text.length) i += 1; // skip closing $
      continue;
    }

    current += text[i];
    i++;
  }

  if (current) segments.push({ type: 'text', content: current });
  return segments;
}

/**
 * Render text with LaTeX to HTML string.
 * Plain text is escaped, math is rendered via KaTeX.
 * Returns { html: string, hasError: boolean }
 */
export function renderLatexToHtml(text) {
  if (!hasLatex(text)) {
    return { html: null, hasError: false }; // null = no LaTeX, use plain text
  }

  const segments = parseLatex(text);
  let html = '';
  let hasError = false;

  for (const seg of segments) {
    if (seg.type === 'text') {
      // Escape HTML in plain text segments
      html += seg.content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br/>');
    } else {
      try {
        html += katex.renderToString(seg.content, {
          displayMode: seg.type === 'display',
          throwOnError: false,
          errorColor: '#ff6b6b',
          trust: false,
          strict: false,
        });
      } catch {
        // Fallback: show raw LaTeX with error styling
        const delim = seg.type === 'display' ? '$$' : '$';
        html += `<span style="color:#ff6b6b">${delim}${seg.content}${delim}</span>`;
        hasError = true;
      }
    }
  }

  return { html, hasError };
}
