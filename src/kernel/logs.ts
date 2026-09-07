/**
 * Kernel log buffer and full-screen viewer.
 *
 * Six writers exist in the kernel (makeLog, start.ts, kernel.ts) with previously zero readers.
 * This provides the bounded buffer (preventing leaks in long-running pages) and the kernel-level
 * full-screen viewer toggled by `ctrl+alt+q`.
 *
 * Works on any site regardless of whether page chrome is present (window/page.ts:148).
 */

import type { LogRecord } from './broker.js';

export const DEFAULT_LOG_CAPACITY = 1000;

export interface LogBuffer extends Array<LogRecord> {
    readonly capacity: number;
    readonly dropped: number;
    subscribe(listener: () => void): () => void;
}

/**
 * Create a bounded log buffer that evicts the oldest entries once capacity is reached.
 *
 * Keeps constructor === Array and non-enumerable methods so deep equality assertions
 * on services.logs work seamlessly.
 */
export function createLogBuffer(capacity = DEFAULT_LOG_CAPACITY): LogBuffer {
    const arr: LogRecord[] = [];
    let dropped = 0;
    const listeners = new Set<() => void>();

    Object.defineProperty(arr, 'capacity', { value: capacity, writable: true, configurable: true });
    Object.defineProperty(arr, 'dropped', { get: () => dropped, configurable: true });
    Object.defineProperty(arr, 'subscribe', {
        value: (listener: () => void) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        configurable: true,
    });
    const origPush = arr.push.bind(arr);
    Object.defineProperty(arr, 'push', {
        value: (...items: LogRecord[]): number => {
            origPush(...items);
            if (arr.length > capacity) {
                const excess = arr.length - capacity;
                arr.splice(0, excess);
                dropped += excess;
            }
            for (const listener of listeners) {
                try { listener(); } catch {}
            }
            return arr.length;
        },
        configurable: true,
    });

    const isLogBuffer = (val: LogRecord[]): val is LogBuffer => true;
    if (!isLogBuffer(arr)) throw new Error('Failed to create LogBuffer');
    return arr;
}

export interface LogViewer {
    readonly host: HTMLElement;
    isOpen(): boolean;
    open(): void;
    close(): void;
    toggle(): void;
    dispose(): void;
}

/**
 * Mount the full-screen log viewer into the root element.
 */
export function mountLogViewer(doc: Document, root: Element, logs: LogBuffer): LogViewer {
    const host = doc.createElement('div');
    host.className = 'mesh-log-viewer';
    host.hidden = true;
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.setAttribute('aria-label', 'System Logs');
    host.tabIndex = -1;

    // Header
    const header = doc.createElement('div');
    header.className = 'mesh-log-header';

    const titleGroup = doc.createElement('div');
    titleGroup.className = 'mesh-log-title-group';

    const title = doc.createElement('span');
    title.className = 'mesh-log-title';
    title.textContent = 'System Logs';
    titleGroup.append(title);

    const stats = doc.createElement('span');
    stats.className = 'mesh-log-stats';
    titleGroup.append(stats);

    header.append(titleGroup);

    // Controls
    const controls = doc.createElement('div');
    controls.className = 'mesh-log-controls';

    // Level filter
    const levelLabel = doc.createElement('label');
    levelLabel.textContent = 'Level: ';
    const levelSelect = doc.createElement('select');
    levelSelect.className = 'mesh-log-level-filter';
    for (const opt of ['all', 'error', 'warn', 'info', 'debug']) {
        const option = doc.createElement('option');
        option.value = opt;
        option.textContent = opt === 'all' ? 'All Levels' : opt.toUpperCase();
        levelSelect.append(option);
    }
    levelLabel.append(levelSelect);
    controls.append(levelLabel);

    // Source filter
    const sourceLabel = doc.createElement('label');
    sourceLabel.textContent = 'Source: ';
    const sourceSelect = doc.createElement('select');
    sourceSelect.className = 'mesh-log-source-filter';
    const allSourcesOpt = doc.createElement('option');
    allSourcesOpt.value = 'all';
    allSourcesOpt.textContent = 'All Sources';
    sourceSelect.append(allSourcesOpt);
    sourceLabel.append(sourceSelect);
    controls.append(sourceLabel);

    // Text search
    const searchInput = doc.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'mesh-log-search';
    searchInput.placeholder = 'Filter message...';
    controls.append(searchInput);

    // Close button
    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'mesh-log-close';
    closeBtn.textContent = 'Close (Esc)';
    controls.append(closeBtn);

    header.append(controls);
    host.append(header);

    // List
    const list = doc.createElement('div');
    list.className = 'mesh-log-list';
    host.append(list);

    root.append(host);

    const updateSourceOptions = (): void => {
        const current = sourceSelect.value;
        const sources = new Set<string>();
        for (const log of logs) {
            sources.add(log.source);
        }
        sourceSelect.replaceChildren();
        const all = doc.createElement('option');
        all.value = 'all';
        all.textContent = 'All Sources';
        sourceSelect.append(all);
        for (const src of Array.from(sources).sort()) {
            const opt = doc.createElement('option');
            opt.value = src;
            opt.textContent = src;
            sourceSelect.append(opt);
        }
        sourceSelect.value = sources.has(current) || current === 'all' ? current : 'all';
    };

    const renderLogs = (): void => {
        updateSourceOptions();

        const levelFilter = levelSelect.value;
        const sourceFilter = sourceSelect.value;
        const query = searchInput.value.trim().toLowerCase();

        const filtered = logs.filter((log) => {
            if (levelFilter !== 'all' && log.level !== levelFilter) return false;
            if (sourceFilter !== 'all' && log.source !== sourceFilter) return false;
            if (query !== '' && !log.message.toLowerCase().includes(query)) return false;
            return true;
        });

        // Update stats
        if (logs.dropped > 0) {
            stats.replaceChildren();
            stats.append(doc.createTextNode(`Showing ${filtered.length} of ${logs.length} logs (`));
            const evictedSpan = doc.createElement('span');
            evictedSpan.className = 'evicted';
            evictedSpan.textContent = `${logs.dropped} oldest logs evicted`;
            stats.append(evictedSpan);
            stats.append(doc.createTextNode(` due to buffer limit of ${logs.capacity})`));
        } else {
            stats.textContent = `Showing ${filtered.length} of ${logs.length} logs (limit ${logs.capacity})`;
        }

        list.replaceChildren();

        if (filtered.length === 0) {
            const empty = doc.createElement('div');
            empty.className = 'mesh-log-empty';
            empty.textContent = logs.length === 0 ? 'No logs recorded.' : 'No logs match the current filter.';
            list.append(empty);
            return;
        }

        for (const log of filtered) {
            const entry = doc.createElement('div');
            entry.className = `mesh-log-entry ${log.level}`;

            const lvl = doc.createElement('span');
            lvl.className = `mesh-log-level ${log.level}`;
            lvl.textContent = `[${log.level.toUpperCase()}]`;
            entry.append(lvl);

            const src = doc.createElement('span');
            src.className = 'mesh-log-source';
            src.textContent = log.source;
            entry.append(src);

            const msg = doc.createElement('span');
            msg.className = 'mesh-log-message';
            msg.textContent = log.message;
            entry.append(msg);

            if (log.data !== undefined) {
                const dataPre = doc.createElement('pre');
                dataPre.className = 'mesh-log-data';
                try {
                    dataPre.textContent = typeof log.data === 'string'
                        ? log.data
                        : JSON.stringify(log.data, null, 2);
                } catch {
                    dataPre.textContent = String(log.data);
                }
                entry.append(dataPre);
            }

            list.append(entry);
        }
    };

    levelSelect.addEventListener('change', () => { renderLogs(); });
    sourceSelect.addEventListener('change', () => { renderLogs(); });
    searchInput.addEventListener('input', () => { renderLogs(); });

    const open = (): void => {
        host.hidden = false;
        renderLogs();
        closeBtn.focus();
    };

    const close = (): void => {
        host.hidden = true;
    };

    const toggle = (): void => {
        if (host.hidden) open(); else close();
    };

    closeBtn.addEventListener('click', () => { close(); });

    const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape' && !host.hidden) {
            e.preventDefault();
            e.stopPropagation();
            close();
        }
    };

    host.addEventListener('keydown', onKey);
    doc.addEventListener('keydown', onKey);

    const unsubscribe = logs.subscribe(() => {
        if (!host.hidden) {
            renderLogs();
        }
    });

    return {
        host,
        isOpen: () => !host.hidden,
        open,
        close,
        toggle,
        dispose: () => {
            unsubscribe();
            host.removeEventListener('keydown', onKey);
            doc.removeEventListener('keydown', onKey);
            host.remove();
        },
    };
}
