/**
 * Previous / next, as links. A component only because links are — `Link` is mounted, so whatever
 * draws one needs a host; it keeps no state. The URL is the state: page 3 is `?page=3`, so it
 * survives a reload, a shared link and the back button.
 */

import { Component, element, Link, props, text, when, type Node } from '@flybyme/mesh-web';

export class Pager extends Component({
    props: props<{
        readonly page: () => number;
        readonly pages: () => number;
        readonly href: (page: number) => string;
    }>(),
}) {
    render(): Node {
        const { page, pages, href } = this.props;
        return element('Row', {
            props: { class: 'ui-pager', role: 'navigation', 'aria-label': 'Pages' },
            children: [
                // `href` as a function: the `when` keeps the link while the page changes under it.
                when(() => page() > 1, () => this.mount(Link, { href: () => href(page() - 1), children: [text('← Previous')] })),
                element('Text', { props: { 'data-page-of': '' }, children: [text(() => `Page ${page()} of ${Math.max(pages(), 1)}`)] }),
                when(() => page() < pages(), () => this.mount(Link, { href: () => href(page() + 1), children: [text('Next →')] })),
            ],
        });
    }
}
