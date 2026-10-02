"use client";

import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * MarkdownPreview — GFM-flavored live rendering, debounced behind React
 * memoization so it never blocks keystrokes.
 */

interface MarkdownPreviewProps {
  markdown: string;
}

function MarkdownPreview({ markdown }: MarkdownPreviewProps) {
  const rendered = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-5 mt-2 border-b border-white/10 pb-3 text-3xl font-bold tracking-tight text-slate-50">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-4 mt-8 text-2xl font-semibold tracking-tight text-slate-100">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-3 mt-6 text-lg font-semibold text-slate-100">
              {children}
            </h3>
          ),
          p: ({ children }) => (
            <p className="mb-4 leading-7 text-slate-300">{children}</p>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-teal-300 underline decoration-teal-300/40 underline-offset-2 transition hover:text-teal-200"
            >
              {children}
            </a>
          ),
          ul: ({ children }) => (
            <ul className="mb-4 list-disc space-y-1.5 pl-6 text-slate-300 marker:text-teal-400">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-4 list-decimal space-y-1.5 pl-6 text-slate-300 marker:text-teal-400">
              {children}
            </ol>
          ),
          blockquote: ({ children }) => (
            <blockquote className="mb-4 rounded-r-lg border-l-2 border-teal-400/70 bg-teal-400/5 py-1 pl-4 pr-3 italic text-slate-300">
              {children}
            </blockquote>
          ),
          code: ({ children, className }) => {
            const isBlock = Boolean(className);
            return isBlock ? (
              <code className="font-mono text-[13px] leading-6 text-emerald-200">
                {children}
              </code>
            ) : (
              <code className="rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[12.5px] text-amber-200">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="mb-5 overflow-x-auto rounded-xl border border-white/10 bg-[#070a11] p-4">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="mb-5 overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-white/10 bg-white/5 px-4 py-2.5 text-left font-semibold text-slate-100">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-white/5 px-4 py-2.5 text-slate-300">
              {children}
            </td>
          ),
          hr: () => <hr className="my-8 border-white/10" />,
          strong: ({ children }) => (
            <strong className="font-semibold text-slate-100">{children}</strong>
          ),
          img: ({ src, alt }) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={typeof src === "string" ? src : ""}
              alt={alt ?? ""}
              className="mb-4 max-w-full rounded-xl border border-white/10"
            />
          ),
        }}
      >
        {markdown}
      </ReactMarkdown>
    ),
    [markdown],
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-10">{rendered}</div>
    </div>
  );
}

export default memo(MarkdownPreview);
