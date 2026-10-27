/**
 * The document's head, as a site's views describe it (`PageHead`). The one place mesh-web writes
 * it: a view returns what it wants from `head()`, and never touches the document itself.
 *
 * Each field has one element. The page's own (in its HTML) is used when there, and its value comes
 * back when a view stops saying otherwise; one made here goes when no view wants it.
 */
import type { PageHead } from './types.js';

const STRUCTURED_DATA_ID = 'mesh-structured-data';

/** One element in the head: found or made, set, and put back. */
interface HeadSlot {
    set(value: string | undefined): void;
}

function slot<E extends HTMLElement>(
    document: Document,
    find: () => E | null,
    make: () => E,
    read: (element: E) => string,
    write: (element: E, value: string) => void,
): HeadSlot {
    const own = find();
    const original = own === null ? undefined : read(own);
    let made: E | undefined;

    return {
        set(value) {
            if (value === undefined) {
                if (own !== null && original !== undefined) write(own, original);
                made?.remove();
                made = undefined;
                return;
            }
            const element = own ?? made ?? (made = make());
            if (!element.isConnected) document.head.appendChild(element);
            write(element, value);
        },
    };
}

export interface DocumentHead {
    /** Show this page's head; a field left out is the page's own again. */
    show(head: PageHead): void;
}

export function documentHead(document: Document): DocumentHead {
    const description = slot(
        document,
        () => document.head.querySelector<HTMLMetaElement>('meta[name="description"]'),
        () => Object.assign(document.createElement('meta'), { name: 'description' }),
        (meta) => meta.content,
        (meta, value) => { meta.content = value; },
    );
    const canonical = slot(
        document,
        () => document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]'),
        () => Object.assign(document.createElement('link'), { rel: 'canonical' }),
        (link) => link.href,
        (link, value) => { link.href = value; },
    );
    const structuredData = slot(
        document,
        () => document.head.querySelector<HTMLScriptElement>('script[type="application/ld+json"]'),
        () => Object.assign(document.createElement('script'), { id: STRUCTURED_DATA_ID, type: 'application/ld+json' }),
        (script) => script.textContent ?? '',
        (script, value) => { script.textContent = value; },
    );
    const root = document.documentElement;
    const originalLang = root.getAttribute('lang');

    return {
        show(head) {
            description.set(head.description);
            canonical.set(head.canonical);
            structuredData.set(head.structuredData === undefined ? undefined : JSON.stringify(head.structuredData));
            const lang = head.lang ?? originalLang;
            if (lang === null) root.removeAttribute('lang');
            else root.setAttribute('lang', lang);
        },
    };
}
