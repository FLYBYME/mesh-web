/**
 * Harbor DNS — the reference console for the mesh-web app model (see ../README.md).
 *
 * This file is the whole map: every URL, the view it mounts, and the layout it is drawn in. Pages
 * do not know their layout and layouts do not know the route table; only this file joins them.
 */

import './console.css';
import { App, element, text, within } from '@flybyme/mesh-web';
import { FakeApi } from './api/fake-api.js';
import { ConsoleLayout } from './layouts/console.layout.js';
import { PublicLayout } from './layouts/public.layout.js';
import { DomainListView } from './pages/domains/domain-list.view.js';
import { DomainView } from './pages/domains/domain-view.js';
import { HomeView } from './pages/home.view.js';
import { SignInView } from './pages/sign-in.view.js';
import { Session } from './services/session.service.js';

const pub = within(PublicLayout);
const inConsole = within(ConsoleLayout);

export default class Console extends App({
    services: [FakeApi, Session],
    routes: {
        '/': pub(HomeView),
        '/sign-in': pub(SignInView),
        '/domains': inConsole(DomainListView),
        '/domains/:domain': inConsole(DomainView),
    },
    // One broken widget costs its own box, and says so; the rest of the console carries on.
    fallback: ({ unit }) => element('Text', {
        props: { role: 'alert', class: 'ui-error', 'data-mount-error': unit },
        children: [text(`Something went wrong showing ${unit}. The details are in the log (ctrl+alt+q).`)],
    }),
}) {}
