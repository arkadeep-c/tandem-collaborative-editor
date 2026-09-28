"use client";

interface SafePreviewProps {
  language: "html" | "css";
  content: string;
}

function srcDocFor(language: "html" | "css", content: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:;">`;
  if (language === "html") {
    return `<!doctype html><html><head><meta charset="utf-8">${csp}<base target="_blank"></head><body>${content}</body></html>`;
  }
  const escaped = content.replace(/<\/style/gi, "<\\/style");
  return `<!doctype html><html><head><meta charset="utf-8">${csp}<style>${escaped}</style></head><body><main class="preview-card"><p class="eyebrow">CSS Preview</p><h1>Tandem stylesheet sandbox</h1><p>Edit CSS on the left. This sample document updates here without scripts, cookies, storage, or application API access.</p><button>Sample button</button><pre>{ "status": "safe preview" }</pre></main></body></html>`;
}

export default function SafePreview({ language, content }: SafePreviewProps) {
  return (
    <div className="flex h-full flex-col bg-[#0a0d13]">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2">
        <span className="text-xs font-semibold text-slate-400">
          {language === "html" ? "HTML Preview" : "CSS Preview"}
        </span>
        <span className="rounded border border-teal-300/20 bg-teal-300/10 px-2 py-0.5 text-[10px] font-medium text-teal-200">
          sandboxed · no scripts
        </span>
      </div>
      <iframe
        title={language === "html" ? "Sandboxed HTML preview" : "Sandboxed CSS preview"}
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={srcDocFor(language, content)}
        className="min-h-0 flex-1 border-0 bg-white"
      />
    </div>
  );
}
