/**
 * View selector overlay.
 *
 * Provides a kernel-level quick-open palette for navigating to any view/route
 * registered in an App, toggled by `ctrl+alt+w` in any mode (single-page site,
 * windowed desktop, or tiled).
 */

import type { AppClass } from '../app/runtime.js';
import { routeParts } from '../app/routes.js';
import type { ViewClass } from '../app/types.js';
import type { MountedApp } from '../app/site.js';
import type { MountedDesktop } from '../app/desktop.js';

export interface ViewSelector {
    readonly host: HTMLElement;
    isOpen(): boolean;
    open(): void;
    close(): void;
    toggle(): void;
    dispose(): void;
}

interface RouteItem {
    readonly pattern: string;
    readonly view: ViewClass;
    readonly title: string;
    readonly isParametric: boolean;
}

export function mountViewSelector(
    doc: Document,
    root: Element,
    App: AppClass,
    site: MountedApp | MountedDesktop,
): ViewSelector {
    const routes: RouteItem[] = Object.entries(App.spec.routes).map(([pattern, route]) => {
        const { view } = routeParts(route);
        const title = typeof view.spec.title === 'string' ? view.spec.title : view.name;
        const isParametric = pattern.includes(':') || view.spec.params !== undefined;
        return { pattern, view, title, isParametric };
    });

    const host = doc.createElement('div');
    host.className = 'mesh-view-selector';
    host.hidden = true;
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.setAttribute('aria-label', 'View Selector');
    host.tabIndex = -1;

    const dialog = doc.createElement('div');
    dialog.className = 'mesh-view-dialog';

    const header = doc.createElement('div');
    header.className = 'mesh-view-header';

    const searchInput = doc.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'mesh-view-search';
    searchInput.placeholder = 'Search views or routes...';
    searchInput.setAttribute('aria-autocomplete', 'list');

    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'mesh-view-close';
    closeBtn.textContent = 'Close (Esc)';

    header.append(searchInput, closeBtn);
    dialog.append(header);

    const list = doc.createElement('div');
    list.className = 'mesh-view-list';
    list.setAttribute('role', 'listbox');
    dialog.append(list);

    host.append(dialog);
    root.append(host);

    let selectedIndex = 0;

    const getFiltered = (): RouteItem[] => {
        const query = searchInput.value.trim().toLowerCase();
        if (query === '') return routes;
        return routes.filter((item) =>
            item.title.toLowerCase().includes(query) ||
            item.pattern.toLowerCase().includes(query) ||
            item.view.name.toLowerCase().includes(query),
        );
    };

    const selectItem = (item: RouteItem): void => {
        if (item.isParametric) {
            searchInput.value = item.pattern;
            searchInput.focus();
            const colonIdx = item.pattern.indexOf(':');
            if (colonIdx !== -1 && typeof searchInput.setSelectionRange === 'function') {
                searchInput.setSelectionRange(colonIdx, item.pattern.length);
            }
        } else {
            close();
            site.navigate(item.pattern);
        }
    };

    const updateSelection = (): void => {
        const children = list.children;
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (child instanceof HTMLElement) {
                const isSelected = i === selectedIndex;
                child.className = isSelected ? 'mesh-view-item selected' : 'mesh-view-item';
                child.setAttribute('aria-selected', isSelected ? 'true' : 'false');
                if (isSelected && typeof child.scrollIntoView === 'function') {
                    child.scrollIntoView({ block: 'nearest' });
                }
            }
        }
    };

    const renderItems = (): void => {
        const filtered = getFiltered();
        if (selectedIndex >= filtered.length) {
            selectedIndex = Math.max(0, filtered.length - 1);
        }
        list.replaceChildren();

        if (filtered.length === 0) {
            const empty = doc.createElement('div');
            empty.className = 'mesh-view-empty';
            empty.textContent = 'No matching views or routes.';
            list.append(empty);
            return;
        }

        for (const [i, item] of filtered.entries()) {
            const row = doc.createElement('div');
            row.className = i === selectedIndex ? 'mesh-view-item selected' : 'mesh-view-item';
            row.setAttribute('role', 'option');
            row.setAttribute('aria-selected', i === selectedIndex ? 'true' : 'false');

            const main = doc.createElement('div');
            main.className = 'mesh-view-item-main';

            const titleSpan = doc.createElement('span');
            titleSpan.className = 'mesh-view-title';
            titleSpan.textContent = item.title;

            const nameSpan = doc.createElement('span');
            nameSpan.className = 'mesh-view-name';
            nameSpan.textContent = item.view.name;

            main.append(titleSpan, nameSpan);

            const right = doc.createElement('div');
            right.className = 'mesh-view-item-right';

            const patternSpan = doc.createElement('span');
            patternSpan.className = 'mesh-view-pattern';
            patternSpan.textContent = item.pattern;
            right.append(patternSpan);

            if (item.isParametric) {
                const badge = doc.createElement('span');
                badge.className = 'mesh-view-param-badge';
                badge.textContent = 'param';
                right.append(badge);
            }

            row.append(main, right);

            row.addEventListener('mouseenter', () => {
                selectedIndex = i;
                updateSelection();
            });

            row.addEventListener('click', () => {
                selectItem(item);
            });

            list.append(row);
        }
    };

    const onSearchKey = (e: KeyboardEvent): void => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            const filtered = getFiltered();
            if (filtered.length > 0) {
                selectedIndex = (selectedIndex + 1) % filtered.length;
                updateSelection();
            }
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            const filtered = getFiltered();
            if (filtered.length > 0) {
                selectedIndex = (selectedIndex - 1 + filtered.length) % filtered.length;
                updateSelection();
            }
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            const val = searchInput.value.trim();
            if (val.startsWith('/') && !val.includes(':')) {
                close();
                site.navigate(val);
                return;
            }
            const filtered = getFiltered();
            const selected = filtered[selectedIndex];
            if (selected !== undefined) {
                selectItem(selected);
            }
            return;
        }
    };

    searchInput.addEventListener('keydown', onSearchKey);

    searchInput.addEventListener('input', () => {
        selectedIndex = 0;
        renderItems();
    });

    closeBtn.addEventListener('click', () => {
        close();
    });

    host.addEventListener('click', (e) => {
        if (e.target === host) {
            close();
        }
    });

    const open = (): void => {
        host.hidden = false;
        searchInput.value = '';
        selectedIndex = 0;
        renderItems();
        searchInput.focus();
    };

    const close = (): void => {
        host.hidden = true;
    };

    const toggle = (): void => {
        if (host.hidden) open(); else close();
    };

    const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape' && !host.hidden) {
            e.preventDefault();
            e.stopPropagation();
            close();
            return;
        }
        if (e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'w') {
            e.preventDefault();
            e.stopPropagation();
            toggle();
        }
    };

    host.addEventListener('keydown', onKey);
    doc.addEventListener('keydown', onKey);

    return {
        host,
        isOpen: () => !host.hidden,
        open,
        close,
        toggle,
        dispose: () => {
            searchInput.removeEventListener('keydown', onSearchKey);
            host.removeEventListener('keydown', onKey);
            doc.removeEventListener('keydown', onKey);
            host.remove();
        },
    };
}
