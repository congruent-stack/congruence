import { useEffect, useId, useMemo, useState } from 'react';
import type { Activity, AgentSettings } from '@congruence/contracts';
import {
  ArrowUpRight,
  Check,
  CircleDot,
  Search,
  TriangleAlert,
  MessageSquare,
  ExternalLink,
  History,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { AgentMessages } from './AgentMessages';
import { desktopSessionLink } from './desktop-session';
import { ActivityHistory } from './ActivityHistory';
import { ActivityMarkdown } from './ActivityMarkdown';
import { markdownPreview } from './markdown-preview';

export const statusLabels = {
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
} as const;
const filters = ['all', 'in_progress', 'blocked', 'done'] as const;
type Filter = (typeof filters)[number];

function relativeTime(value: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
export function safeSourceUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function messagingWarning(item: Activity, settings?: AgentSettings, error?: string) {
  if (error) return 'Agent settings could not be loaded. Open Agents to check the connection.';
  if (!settings) return '';
  const provider = item.agentTarget?.provider;
  // Claude Desktop needs the Congruence mod, not an executable. The dialog explains a missing mod.
  if (provider === 'claude-desktop' || (!provider && item.desktopSession?.provider === 'claude'))
    return '';
  // Outside Claude Desktop, Claude Code has no way to receive dashboard messages.
  if (!provider && item.source.toLowerCase().includes('claude'))
    return 'Claude Code receives dashboard messages only in Claude Desktop with the Congruence mod.';
  const configured =
    provider === 'codex-desktop'
      ? settings.codexCommand.trim()
      : settings.codexSocket.trim()
        ? settings.codexCommand.trim()
        : settings.codexUrl.trim() || (!provider && settings.codexCommand.trim());
  return configured
    ? ''
    : 'Agent settings are empty. Open Agents → Agent settings to configure this agent.';
}

function ActivityRow({
  item,
  selected,
  onSelect,
}: {
  item: Activity;
  selected: boolean;
  onSelect: () => void;
}) {
  const descriptionId = useId();
  const statusId = `${descriptionId}-status`;
  const subtitleId = `${descriptionId}-subtitle`;
  const Icon =
    item.status === 'done' ? Check : item.status === 'blocked' ? TriangleAlert : CircleDot;
  return (
    <article className="activity-item">
      <button
        className="activity-main"
        aria-label={item.title}
        aria-describedby={item.subtitle ? `${statusId} ${subtitleId}` : statusId}
        aria-pressed={selected}
        aria-controls="selected-activity"
        onClick={onSelect}
      >
        <span
          id={statusId}
          className={`activity-icon status-${item.status}`}
          role="img"
          aria-label={statusLabels[item.status]}
          title={statusLabels[item.status]}
        >
          <Icon size={16} aria-hidden="true" />
        </span>
        <span className="activity-content">
          <span className="activity-title">{item.title}</span>
          {item.subtitle && (
            <span className="activity-subtitle" id={subtitleId}>
              {item.subtitle}
            </span>
          )}
        </span>
      </button>
    </article>
  );
}

function ActivityDetails({
  item,
  onMessage,
  onHistory,
  disabled,
  warning,
}: {
  item: Activity;
  onMessage: () => void;
  onHistory: () => void;
  disabled: boolean;
  warning: string;
}) {
  const warningId = useId();
  const sourceUrl = safeSourceUrl(item.sourceUrl);
  const desktopLink = desktopSessionLink(item);
  return (
    <article
      className="activity-reader"
      id="selected-activity"
      aria-labelledby="selected-activity-title"
    >
      <header className="activity-reader-heading">
        <h2 id="selected-activity-title">{item.title}</h2>
        {item.subtitle && <p className="activity-subtitle">{item.subtitle}</p>}
        <div className="activity-meta">
          <span className={`status-badge status-${item.status}`}>{statusLabels[item.status]}</span>
          <span>·</span>
          <span className="source-label">{item.source}</span>
          <span>·</span>
          <time dateTime={item.updatedAt} title={new Date(item.updatedAt).toLocaleString()}>
            {relativeTime(item.updatedAt)}
          </time>
        </div>
      </header>
      <div className="activity-detail">
        {item.summary.trim() ? (
          <ActivityMarkdown>{item.summary}</ActivityMarkdown>
        ) : (
          <p className="activity-summary-empty">This agent has not shared a summary yet.</p>
        )}
        <div className="activity-detail-footer">
          <span>
            Work ID <code>{item.workId}</code>
          </span>
          {sourceUrl && (
            <a className="text-link" href={sourceUrl} target="_blank" rel="noopener noreferrer">
              Open source <ArrowUpRight size={14} />
            </a>
          )}
        </div>
        <p className="last-reported">Reported {new Date(item.updatedAt).toLocaleString()}.</p>
        <div className="message-agent-actions">
          {desktopLink ? (
            <a className="button button-secondary button-small" href={desktopLink.href}>
              <ExternalLink size={14} aria-hidden="true" />
              {desktopLink.label}
            </a>
          ) : (
            <Button
              variant="secondary"
              size="small"
              disabled
              title="This activity has no linked desktop session."
            >
              <ExternalLink size={14} aria-hidden="true" />
              Open in desktop
            </Button>
          )}
          <div className="message-agent-control">
            <Button
              variant="secondary"
              size="small"
              className="message-agent-button"
              onClick={onMessage}
              disabled={disabled}
              aria-describedby={warning ? warningId : undefined}
            >
              <MessageSquare size={14} />
              Message agent
            </Button>
            {warning && (
              <span className="message-agent-warning" tabIndex={0} aria-label={warning}>
                <TriangleAlert size={16} aria-hidden="true" />
                <span id={warningId} role="tooltip">
                  {warning}
                </span>
              </span>
            )}
          </div>
          <Button variant="secondary" size="small" onClick={onHistory}>
            <History size={14} aria-hidden="true" />
            Version history
            <span className="activity-version-count">{item.revision}</span>
          </Button>
        </div>
      </div>
    </article>
  );
}

export function ActivityFeed({
  items,
  loading,
  agentSettings,
  agentSettingsError,
}: {
  items: Activity[];
  loading: boolean;
  agentSettings?: AgentSettings;
  agentSettingsError?: string;
}) {
  const [messageItem, setMessageItem] = useState<Activity>();
  const [historyItem, setHistoryItem] = useState<Activity>();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>();
  const summaryPreviews = useMemo(
    () => new Map(items.map((item) => [item.id, markdownPreview(item.summary)])),
    [items],
  );
  const matches = items.filter(
    (item) =>
      (filter === 'all' || item.status === filter) &&
      `${item.title} ${item.subtitle} ${summaryPreviews.get(item.id)} ${item.summary} ${item.source} ${item.workId} ${item.workKey}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const selectedItem = loading
    ? undefined
    : (matches.find((item) => item.id === selectedId) ?? matches[0]);
  // Keep the first automatic selection stable when new reports arrive or reorder the list.
  useEffect(() => {
    setSelectedId(selectedItem?.id);
  }, [selectedItem?.id]);
  return (
    <div className="activity-panel">
      <section className="panel activity-sidebar" aria-labelledby="activity-title">
        <div className="panel-heading">
          <h2 id="activity-title">Activity</h2>
          <label className="search-box">
            <Search size={15} />
            <input
              aria-label="Search activity"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
            />
          </label>
        </div>
        <div className="activity-toolbar">
          <div className="filter-tabs" role="group" aria-label="Filter activity">
            {filters.map((value) => (
              <button
                key={value}
                aria-pressed={filter === value}
                className={filter === value ? 'active' : ''}
                onClick={() => setFilter(value)}
              >
                {value === 'all' ? 'All activity' : statusLabels[value]}
                <span className="filter-count">
                  {loading
                    ? '–'
                    : value === 'all'
                      ? items.length
                      : items.filter((item) => item.status === value).length}
                </span>
              </button>
            ))}
          </div>
        </div>
        {loading ? (
          <div className="activity-empty" role="status">
            <span className="loading-dot" />
            Loading activity…
          </div>
        ) : items.length === 0 ? (
          <div className="activity-empty">
            <h3>No activity yet</h3>
            <p>Ask an agent to “report activity to congruence” to share its progress.</p>
          </div>
        ) : matches.length === 0 ? (
          <div className="activity-empty compact">
            <h3>No matching activity</h3>
            <Button
              variant="ghost"
              size="small"
              onClick={() => {
                setFilter('all');
                setQuery('');
              }}
            >
              Clear filters
            </Button>
          </div>
        ) : (
          <div className="activity-list" aria-label="Activities">
            {matches.map((item) => (
              <ActivityRow
                key={item.id}
                item={item}
                selected={selectedItem?.id === item.id}
                onSelect={() => setSelectedId(item.id)}
              />
            ))}
          </div>
        )}
      </section>
      {selectedItem ? (
        <ActivityDetails
          key={selectedItem.id}
          item={selectedItem}
          disabled={
            !agentSettings ||
            Boolean(messagingWarning(selectedItem, agentSettings, agentSettingsError))
          }
          warning={messagingWarning(selectedItem, agentSettings, agentSettingsError)}
          onMessage={() => setMessageItem(selectedItem)}
          onHistory={() => setHistoryItem(selectedItem)}
        />
      ) : (
        <div className="activity-reader activity-reader-empty" id="selected-activity">
          <p>{loading ? 'Loading details…' : 'Select an activity to view its details.'}</p>
        </div>
      )}
      {historyItem && (
        <ActivityHistory
          item={items.find((item) => item.id === historyItem.id) ?? historyItem}
          onClose={() => setHistoryItem(undefined)}
        />
      )}
      {messageItem &&
        agentSettings &&
        !messagingWarning(messageItem, agentSettings, agentSettingsError) && (
          <AgentMessages
            item={items.find((item) => item.id === messageItem.id) ?? messageItem}
            onClose={() => setMessageItem(undefined)}
          />
        )}
    </div>
  );
}
