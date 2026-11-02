import { useId } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components: Components = {
  a({ node: _node, children, href, ...props }) {
    if (!href) return <span>{children}</span>;
    const newTab = !href.startsWith('#');
    return (
      <a
        {...props}
        href={href}
        target={newTab ? '_blank' : undefined}
        rel={newTab ? 'noopener noreferrer' : undefined}
      >
        {children}
      </a>
    );
  },
  img({ src, alt, title }) {
    return typeof src === 'string' && src ? (
      <img
        src={src}
        alt={alt ?? ''}
        title={title}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
      />
    ) : (
      <span className="activity-markdown-image-alt">{alt || 'Image'}</span>
    );
  },
  pre({ node: _node, children, ...props }) {
    return (
      <pre {...props} tabIndex={0}>
        {children}
      </pre>
    );
  },
  table({ node: _node, children, ...props }) {
    return (
      <div className="activity-markdown-table" tabIndex={0} role="region" aria-label="Table">
        <table {...props}>{children}</table>
      </div>
    );
  },
};

export function ActivityMarkdown({ children }: { children: string }) {
  const prefix = useId();
  return (
    <div className="activity-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        remarkRehypeOptions={{ clobberPrefix: `activity-${prefix}-` }}
        skipHtml
        components={components}
      >
        {children}
      </Markdown>
    </div>
  );
}
