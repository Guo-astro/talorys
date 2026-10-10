import { memo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { cn, copyText } from "../lib/utils";

function CodeBlock({ children, className }: { children?: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const text = String(children ?? "").replace(/\n$/, "");
  const lang = /language-(\w+)/.exec(className ?? "")?.[1];
  return (
    <div className="group relative">
      <div className="absolute right-2 top-2 flex items-center gap-2">
        {lang && <span className="text-[11px] uppercase tracking-wide text-fg-subtle">{lang}</span>}
        <button type="button"
          onClick={() => {
            void copyText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="rounded-md border border-border bg-surface p-1 text-fg-subtle opacity-0 transition-opacity hover:text-fg group-hover:opacity-100 focus:opacity-100"
          aria-label="Copy code"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
      <pre>
        <code className={className}>{text}</code>
      </pre>
    </div>
  );
}

const components: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const isBlock = /language-/.test(className ?? "") || String(children).includes("\n");
    return isBlock ? <CodeBlock className={className}>{children}</CodeBlock> : <code>{children}</code>;
  },
  // Links open in a new tab without referrer or opener.
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
  // Never load remote images from model output (privacy + exfiltration defence).
  img: ({ alt }) => <span className="text-fg-subtle">[image: {alt}]</span>,
};

/** Safe Markdown renderer: raw HTML is not rendered (react-markdown default). */
export const Markdown = memo(function Markdown({ content, compact }: { content: string; compact?: boolean }) {
  return (
    <div className={cn("prose-talorys", compact && "text-sm leading-6")}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {content}
      </ReactMarkdown>
    </div>
  );
});
