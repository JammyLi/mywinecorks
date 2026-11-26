/** User manual chapters: src/manual/{en,zh}/NN-slug.md (same file names in both languages). */
import type { MarkdownInstance } from 'astro';
import type { Lang } from '../i18n/index.ts';

type Chapter = { slug: string; n: number; title: string; summary: string; Content: MarkdownInstance<Record<string, string>>['Content'] };
const files = import.meta.glob<MarkdownInstance<{ title: string; summary: string }>>('./*/*.md', { eager: true });

export function chapters(lang: Lang): Chapter[] {
  const dir = lang === 'en' ? 'en' : 'zh';
  return Object.entries(files)
    .filter(([p]) => p.startsWith(`./${dir}/`))
    .map(([p, m]) => {
      const base = p.split('/').pop()!.replace(/\.md$/, '');
      const [, n, slug] = /^(\d+)-(.+)$/.exec(base)!;
      return { slug, n: Number(n), title: m.frontmatter.title, summary: m.frontmatter.summary, Content: m.Content };
    })
    .sort((a, b) => a.n - b.n);
}
