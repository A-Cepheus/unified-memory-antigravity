import React, { useEffect, useMemo, useState } from 'react';
import type {
  CallToolFn,
  ClaudeMemoryTopic,
  ClaudeMemoryType,
  ClaudeProjectSummary,
  ProjectMemoriesPayload,
} from '../types.js';

interface Props {
  projects: ClaudeProjectSummary[];
  selectedSlug: string;
  onSelectSlug: (slug: string) => void;
  callTool: CallToolFn;
  onOverviewRefresh: () => Promise<void>;
  onNotify: (msg: string, tone?: 'info' | 'success' | 'warn' | 'danger') => void;
}

const TYPE_DESCRIPTIONS: Record<ClaudeMemoryType, string> = {
  user: 'User role, expertise, preferences, communication style',
  feedback: 'Explicit user corrections, constraints, confirmed patterns',
  project: 'Ongoing work context, goals, architectural decisions not in git',
  reference: 'Pointers to external dashboards, docs, issue trackers',
};

const TYPE_BADGE: Record<string, string> = {
  user: 'info',
  feedback: 'warn',
  project: 'success',
  reference: '',
};

interface TopicDraft {
  isNew: boolean;
  filename: string;
  name: string;
  description: string;
  type: ClaudeMemoryType;
  body: string;
}

export const ClaudeTab: React.FC<Props> = ({
  projects,
  selectedSlug,
  onSelectSlug,
  callTool,
  onOverviewRefresh,
  onNotify,
}) => {
  const [data, setData] = useState<ProjectMemoriesPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [draft, setDraft] = useState<TopicDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingIndex, setEditingIndex] = useState(false);
  const [indexDraft, setIndexDraft] = useState('');

  const loadProject = async (slug: string) => {
    if (!slug) return;
    setLoading(true);
    try {
      const res = await callTool<ProjectMemoriesPayload>('ui_get_project_memories', { slug });
      setData(res);
      setIndexDraft(res.index.content);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), 'danger');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedSlug) {
      loadProject(selectedSlug);
    } else if (projects.length > 0) {
      onSelectSlug(projects[0].slug);
    }
  }, [selectedSlug, projects.length]);

  const filteredTopics = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.topics.filter((t) => {
      if (typeFilter !== 'all' && t.type !== typeFilter) return false;
      if (!q) return true;
      return (
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.filename.toLowerCase().includes(q) ||
        t.body.toLowerCase().includes(q)
      );
    });
  }, [data, typeFilter, search]);

  const handleSaveTopic = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft || !selectedSlug) return;
    setSaving(true);
    try {
      const res = await callTool<{ warnings?: string[] }>('ui_save_topic', {
        slug: selectedSlug,
        filename: draft.isNew ? draft.filename.trim() || undefined : draft.filename,
        name: draft.name.trim(),
        description: draft.description.trim(),
        type: draft.type,
        body: draft.body,
      });
      setDraft(null);
      await loadProject(selectedSlug);
      await onOverviewRefresh();
      if (res.warnings && res.warnings.length > 0) {
        onNotify(`Saved with warning: ${res.warnings[0]}`, 'warn');
      } else {
        onNotify('Topic saved & MEMORY.md synced (v2.1.x metadata schema).', 'success');
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), 'danger');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteTopic = async (topic: ClaudeMemoryTopic) => {
    if (!selectedSlug) return;
    if (!window.confirm(`Delete "${topic.filename}" and remove its entry from MEMORY.md?`)) {
      return;
    }
    try {
      await callTool('ui_delete_topic', { slug: selectedSlug, filename: topic.filename });
      if (expandedFile === topic.filename) setExpandedFile(null);
      await loadProject(selectedSlug);
      await onOverviewRefresh();
      onNotify(`Deleted ${topic.filename}.`, 'info');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), 'danger');
    }
  };

  const handleSaveIndex = async () => {
    if (!selectedSlug) return;
    setSaving(true);
    try {
      await callTool('ui_save_memory_index', { slug: selectedSlug, content: indexDraft });
      setEditingIndex(false);
      await loadProject(selectedSlug);
      await onOverviewRefresh();
      onNotify('MEMORY.md saved atomically.', 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : String(err), 'danger');
    } finally {
      setSaving(false);
    }
  };

  const linePct = data ? Math.min(100, (data.index.totalLines / data.index.maxLines) * 100) : 0;
  const bytePct = data ? Math.min(100, (data.index.totalBytes / data.index.maxBytes) * 100) : 0;
  const lineTone = linePct >= 95 ? 'danger' : linePct >= 80 ? 'warn' : '';
  const byteTone = bytePct >= 95 ? 'danger' : bytePct >= 80 ? 'warn' : '';

  return (
    <div>
      {/* Project Picker */}
      <div className="um-card um-section">
        <div className="um-row">
          <select
            className="um-select"
            style={{ flex: 1, minWidth: 200 }}
            value={selectedSlug}
            onChange={(e) => onSelectSlug(e.target.value)}
          >
            {projects.length === 0 && <option value="">No Claude projects found</option>}
            {projects.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.displayPath} ({p.topicCount} topics)
              </option>
            ))}
          </select>
          <button
            className="um-btn"
            onClick={() => selectedSlug && loadProject(selectedSlug)}
            disabled={loading || !selectedSlug}
          >
            Refresh
          </button>
          <button
            className="um-btn primary"
            disabled={!selectedSlug}
            onClick={() =>
              setDraft({
                isNew: true,
                filename: '',
                name: '',
                description: '',
                type: 'project',
                body: '',
              })
            }
          >
            + New Topic
          </button>
        </div>
        {data && (
          <div className="um-muted um-mono" style={{ marginTop: 6 }}>
            {data.memoryDir}
          </div>
        )}
      </div>

      {/* MEMORY.md Index Budget & Viewer */}
      {data && (
        <div className="um-card um-section">
          <div className="um-card-header">
            <div className="um-row">
              <h3 className="um-card-title">MEMORY.md Startup Index</h3>
              {data.index.truncated ? (
                <span className="um-badge danger">Truncated at 200L / 25 KB</span>
              ) : (
                <span className="um-badge success">Within Startup Cap</span>
              )}
            </div>
            <button className="um-btn sm" onClick={() => setEditingIndex((v) => !v)}>
              {editingIndex ? 'Close Editor' : 'Edit MEMORY.md'}
            </button>
          </div>

          <div className="um-grid-2">
            <div>
              <div className="um-row-between um-muted">
                <span>Lines</span>
                <span className="um-mono">
                  {data.index.totalLines} / {data.index.maxLines}
                </span>
              </div>
              <div className="um-progress-track">
                <div className={`um-progress-fill ${lineTone}`} style={{ width: `${linePct}%` }} />
              </div>
            </div>
            <div>
              <div className="um-row-between um-muted">
                <span>Size</span>
                <span className="um-mono">
                  {(data.index.totalBytes / 1024).toFixed(1)} / 25.0 KB
                </span>
              </div>
              <div className="um-progress-track">
                <div className={`um-progress-fill ${byteTone}`} style={{ width: `${bytePct}%` }} />
              </div>
            </div>
          </div>

          {editingIndex ? (
            <div style={{ marginTop: 10 }}>
              <textarea
                className="um-textarea"
                style={{ minHeight: 200 }}
                value={indexDraft}
                onChange={(e) => setIndexDraft(e.target.value)}
              />
              <div className="um-row" style={{ marginTop: 8, justifyContent: 'flex-end' }}>
                <button className="um-btn" onClick={() => setEditingIndex(false)}>
                  Cancel
                </button>
                <button className="um-btn primary" onClick={handleSaveIndex} disabled={saving}>
                  {saving ? 'Saving...' : 'Save MEMORY.md'}
                </button>
              </div>
            </div>
          ) : data.index.exists && data.index.content.trim() ? (
            <pre className="um-pre" style={{ maxHeight: 180 }}>
              {data.index.content}
            </pre>
          ) : (
            <div className="um-empty" style={{ padding: '12px 0 4px' }}>
              No MEMORY.md yet — creating a topic note will generate it automatically.
            </div>
          )}
        </div>
      )}

      {/* Topics Filter + Cards */}
      {data && (
        <div className="um-card um-section">
          <div className="um-card-header">
            <h3 className="um-card-title">Topic Notes ({filteredTopics.length})</h3>
            <div className="um-pill-bar">
              {(['all', 'user', 'feedback', 'project', 'reference'] as const).map((t) => (
                <button
                  key={t}
                  className={`um-pill ${typeFilter === t ? 'active' : ''}`}
                  onClick={() => setTypeFilter(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <input
            className="um-input"
            style={{ marginBottom: 10 }}
            placeholder="Filter topics by title, description, filename, or content..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />

          {loading ? (
            <div className="um-empty">Loading project memories...</div>
          ) : filteredTopics.length === 0 ? (
            <div className="um-empty">No topic memories match the current filter.</div>
          ) : (
            <div className="um-list">
              {filteredTopics.map((topic) => {
                const isExpanded = expandedFile === topic.filename;
                return (
                  <div className="um-item" key={topic.filename}>
                    <div className="um-row-between">
                      <div className="um-row">
                        <strong>{topic.name}</strong>
                        <span className={`um-badge ${TYPE_BADGE[topic.type] ?? ''}`}>
                          {topic.type}
                        </span>
                        <span className="um-badge">
                          {topic.schema === 'nested_metadata' ? 'v2.1 metadata' : topic.schema}
                        </span>
                      </div>
                      <div className="um-row">
                        <button
                          className="um-btn sm"
                          onClick={() => setExpandedFile(isExpanded ? null : topic.filename)}
                        >
                          {isExpanded ? 'Hide' : 'Read'}
                        </button>
                        <button
                          className="um-btn sm"
                          onClick={() =>
                            setDraft({
                              isNew: false,
                              filename: topic.filename,
                              name: topic.name,
                              description: topic.description,
                              type: (['user', 'feedback', 'project', 'reference'].includes(
                                topic.type,
                              )
                                ? topic.type
                                : 'project') as ClaudeMemoryType,
                              body: topic.body,
                            })
                          }
                        >
                          Edit
                        </button>
                        <button
                          className="um-btn sm danger"
                          onClick={() => handleDeleteTopic(topic)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>

                    {topic.description && (
                      <div style={{ marginTop: 4, color: 'var(--um-text-2)' }}>
                        {topic.description}
                      </div>
                    )}

                    <div className="um-row um-muted" style={{ marginTop: 6 }}>
                      <span className="um-mono">{topic.filename}</span>
                      <span>·</span>
                      <span>{topic.sizeBytes} B</span>
                      {topic.modified && (
                        <>
                          <span>·</span>
                          <span>modified {topic.modified.slice(0, 19).replace('T', ' ')}Z</span>
                        </>
                      )}
                    </div>

                    {isExpanded && <pre className="um-pre">{topic.body || topic.rawContent}</pre>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Create / Edit Modal */}
      {draft && (
        <div className="um-modal-backdrop" onClick={() => !saving && setDraft(null)}>
          <div className="um-modal" onClick={(e) => e.stopPropagation()}>
            <div className="um-card-header">
              <h3 className="um-card-title">
                {draft.isNew ? 'New Claude Memory Topic' : `Edit ${draft.filename}`}
              </h3>
              <span className="um-badge info">v2.1.x metadata schema</span>
            </div>

            <form onSubmit={handleSaveTopic}>
              <div className="um-field">
                <label className="um-label">Type</label>
                <select
                  className="um-select"
                  value={draft.type}
                  onChange={(e) =>
                    setDraft({ ...draft, type: e.target.value as ClaudeMemoryType })
                  }
                >
                  {(['user', 'feedback', 'project', 'reference'] as const).map((t) => (
                    <option key={t} value={t}>
                      {t} — {TYPE_DESCRIPTIONS[t]}
                    </option>
                  ))}
                </select>
              </div>

              <div className="um-field">
                <label className="um-label">Name (Title / Slug)</label>
                <input
                  className="um-input"
                  required
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="e.g. feedback-no-db-mocks"
                />
              </div>

              {draft.isNew && (
                <div className="um-field">
                  <label className="um-label">Filename (optional, auto-derived from name)</label>
                  <input
                    className="um-input um-mono"
                    value={draft.filename}
                    onChange={(e) => setDraft({ ...draft, filename: e.target.value })}
                    placeholder="feedback_no_db_mocks.md"
                  />
                </div>
              )}

              <div className="um-field">
                <label className="um-label">
                  Description (one-line hook shown in MEMORY.md index)
                </label>
                <input
                  className="um-input"
                  required
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder="Concise summary for recall matching"
                />
              </div>

              <div className="um-field">
                <label className="um-label">Body (Markdown)</label>
                <textarea
                  className="um-textarea"
                  required
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  placeholder="Record the decision, why it matters, and how to apply it..."
                />
              </div>

              <div className="um-row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
                <button
                  type="button"
                  className="um-btn"
                  onClick={() => setDraft(null)}
                  disabled={saving}
                >
                  Cancel
                </button>
                <button type="submit" className="um-btn primary" disabled={saving}>
                  {saving ? 'Saving...' : 'Save & Sync MEMORY.md'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
