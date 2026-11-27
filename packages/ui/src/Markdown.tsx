import { Fragment, type ReactNode } from 'react';

/**
 * A small Markdown renderer for the built-in manuals (HQ and the customer portal).
 * Builds React elements only (no innerHTML), so it works under the strict security policy.
 * Supports: # ## ### headings, paragraphs, - and 1. lists, > notes, **bold**, `code`, [text](link).
 */
export function Markdown({ text, onLink }: { text: string; onLink?: (href: string) => void }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, '').split('\n');
  let i = 0;
  let k = 0;
  const inline = (s: string) => renderInline(s, onLink);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const id = slugify(h[2]);
      const body = inline(h[2]);
      blocks.push(
        level === 1 ? (
          <h1 key={k++} id={id}>
            {body}
          </h1>
        ) : level === 2 ? (
          <h2 key={k++} id={id}>
            {body}
          </h2>
        ) : (
          <h3 key={k++} id={id}>
            {body}
          </h3>
        ),
      );
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/).test(lines[i])) {
        let item = lines[i].replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/, '');
        i++;
        // Continuation lines (indented) belong to the same item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i]))
          item += ' ' + lines[i++].trim();
        items.push(item);
      }
      const lis = items.map((it, n) => <li key={n}>{inline(it)}</li>);
      blocks.push(ordered ? <ol key={k++}>{lis}</ol> : <ul key={k++}>{lis}</ul>);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const parts: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) parts.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(
        <aside key={k++} className="md-note">
          {inline(parts.join(' '))}
        </aside>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|>|\s*[-*]\s+|\s*\d+[.)]\s+)/.test(lines[i]))
      para.push(lines[i++].trim());
    blocks.push(<p key={k++}>{inline(para.join(' '))}</p>);
  }
  return <div className="md">{blocks}</div>;
}

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[*`[\]()]/g, '')
    .trim()
    .replace(/\s+/g, '-');

function renderInline(s: string, onLink?: (href: string) => void): ReactNode {
  const out: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(<Fragment key={n++}>{s.slice(last, m.index)}</Fragment>);
    if (m[2] != null) out.push(<strong key={n++}>{m[2]}</strong>);
    else if (m[4] != null) out.push(<code key={n++}>{m[4]}</code>);
    else {
      const href = m[7];
      const safe = /^(https?:\/\/|\/|#|mailto:)/.test(href) ? href : '#';
      const internal = onLink && !/^(https?:|mailto:)/.test(safe);
      out.push(
        <a
          key={n++}
          href={safe}
          {...(/^https?:/.test(safe) ? { target: '_blank', rel: 'noreferrer' } : {})}
          onClick={
            internal
              ? (e) => {
                  e.preventDefault();
                  onLink(safe);
                }
              : undefined
          }
        >
          {m[6]}
        </a>,
      );
    }
    last = re.lastIndex;
  }
  if (last < s.length) out.push(<Fragment key={n++}>{s.slice(last)}</Fragment>);
  return out;
}

/** A manual chapter: file name NN-slug.md, first "# " line is its title. */
export interface ManualChapter {
  slug: string;
  title: string;
  text: string;
}

/** Turns import.meta.glob('./help/<lang>/*.md', { query: '?raw', eager: true, import: 'default' }) into chapters. */
export function chaptersFrom(files: Record<string, string>): ManualChapter[] {
  return Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, text]) => {
      const file = path.split('/').pop()!.replace(/\.md$/, '');
      const slug = file.replace(/^\d+-/, '');
      const title = /^#\s+(.+)$/m.exec(text)?.[1] ?? slug;
      return { slug, title, text };
    });
}

/** Table of contents + one chapter + previous/next. Routing is left to the app (onOpen). */
export function ManualView({
  chapters,
  current,
  onOpen,
  labels,
}: {
  chapters: ManualChapter[];
  current?: string;
  onOpen: (slug: string) => void;
  labels: { contents: string; prev: string; next: string };
}) {
  const idx = Math.max(
    0,
    chapters.findIndex((c) => c.slug === current),
  );
  const ch = chapters[idx];
  if (!ch) return null;
  const go = (slug: string) => (e: { preventDefault: () => void }) => {
    e.preventDefault();
    onOpen(slug);
    window.scrollTo(0, 0);
  };
  const prev = chapters[idx - 1];
  const next = chapters[idx + 1];
  return (
    <div className="manual">
      <nav className="manual-toc" aria-label={labels.contents}>
        {chapters.map((c, n) => (
          <a key={c.slug} href={`#${c.slug}`} className={n === idx ? 'active' : ''} onClick={go(c.slug)}>
            {n + 1}. {c.title}
          </a>
        ))}
      </nav>
      <article>
        <Markdown
          text={ch.text}
          onLink={(href) =>
            href.startsWith('#') && chapters.some((c) => c.slug === href.slice(1)) && onOpen(href.slice(1))
          }
        />
        <div className="manual-nav">
          {prev ? (
            <a href={`#${prev.slug}`} onClick={go(prev.slug)}>
              ← {labels.prev}: {prev.title}
            </a>
          ) : (
            <span />
          )}
          {next && (
            <a href={`#${next.slug}`} onClick={go(next.slug)}>
              {labels.next}: {next.title} →
            </a>
          )}
        </div>
      </article>
    </div>
  );
}
