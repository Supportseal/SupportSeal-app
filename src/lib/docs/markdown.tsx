import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Minimal markdown renderer for the docs pages: headings, paragraphs, lists,
 * fenced code, tables, blockquotes, `code`, **bold** and [links](url). Builds
 * React nodes (no HTML injection) from the repo's own content files.
 */

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function slugifyHeading(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = m.index;
    if (m[1] !== undefined) {
      out.push(<code key={key} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[0.875em] text-heading">{m[1]}</code>);
    } else if (m[2] !== undefined) {
      out.push(<strong key={key} className="font-semibold text-heading">{m[2]}</strong>);
    } else {
      const href = m[4];
      const cls = "text-primary underline underline-offset-2 hover:text-primary-dark";
      out.push(
        href.startsWith("/") || href.startsWith("#") ? (
          <Link key={key} href={href} className={cls}>{m[3]}</Link>
        ) : (
          <a key={key} href={href} className={cls} rel="noreferrer">{m[3]}</a>
        ),
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
const isTableSep = (line: string | undefined) => !!line && /^\|?\s*:?-{2,}[-|\s:]*$/.test(line);
const BLOCK_START = /^(#{1,3} |```|> |[-*] |\d+\. |\|)/;

export function renderMarkdown(source: string): ReactNode[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = blocks.length;
    if (!line.trim()) {
      i++;
    } else if (line.startsWith("```")) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      i++;
      blocks.push(
        <pre key={key} className="overflow-x-auto rounded-lg border border-ink-rule bg-brand-ink p-4 text-sm leading-relaxed text-mint-100 dark:border-border">
          <code className="font-mono">{code.join("\n")}</code>
        </pre>,
      );
    } else if (/^#{1,3} /.test(line)) {
      const level = line.indexOf(" ");
      const text = line.slice(level + 1);
      const id = slugifyHeading(text);
      if (level === 1) {
        blocks.push(<h1 key={key} className="text-[2rem] font-semibold leading-tight text-heading">{renderInline(text)}</h1>);
      } else {
        const Tag = level === 2 ? "h2" : "h3";
        const size = level === 2 ? "mt-10 text-2xl" : "mt-6 text-lg";
        blocks.push(<Tag key={key} id={id} className={`${size} scroll-mt-24 font-semibold text-heading`}>{renderInline(text)}</Tag>);
      }
      i++;
    } else if (line.startsWith("|") && isTableSep(lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].startsWith("|"); i++) rows.push(cells(lines[i]));
      blocks.push(
        <div key={key} className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
            <thead className="bg-surface-2 text-heading">
              <tr>{head.map((h, c) => <th key={c} className="px-3 py-2 font-semibold">{renderInline(h)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r} className="border-t border-border align-top">
                  {row.map((cell, c) => <td key={c} className="px-3 py-2">{renderInline(cell)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (/^([-*]|\d+\.) /.test(line)) {
      const ordered = /^\d/.test(line);
      const items: string[] = [];
      for (; i < lines.length && /^(?:[-*]|\d+\.) /.test(lines[i]); i++) {
        let item = lines[i].replace(/^(?:[-*]|\d+\.) /, "");
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) item += ` ${lines[++i].trim()}`;
        items.push(item);
      }
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={key} className={`${ordered ? "list-decimal" : "list-disc"} space-y-1.5 ps-6 marker:text-muted`}>
          {items.map((item, n) => <li key={n}>{renderInline(item)}</li>)}
        </Tag>,
      );
    } else if (line.startsWith("> ")) {
      const quote: string[] = [];
      for (; i < lines.length && lines[i].startsWith("> "); i++) quote.push(lines[i].slice(2));
      blocks.push(<blockquote key={key} className="border-s-4 border-primary ps-4 text-muted">{renderInline(quote.join(" "))}</blockquote>);
    } else {
      const para: string[] = [];
      for (; i < lines.length && lines[i].trim() && !(para.length && BLOCK_START.test(lines[i])); i++) para.push(lines[i].trim());
      blocks.push(<p key={key}>{renderInline(para.join(" "))}</p>);
    }
  }
  return blocks;
}
