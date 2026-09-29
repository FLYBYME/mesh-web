/**
 * Phase 1 of docs/app-model.md: every rule the app model promises, as a compile-time test.
 *
 * Checked by `npm run typecheck` (tsconfig.check.json includes test/**), never executed — some of
 * these classes are deliberately wrong. Each `@ts-expect-error` must fail for the reason its comment
 * gives; one that stops failing is reported as an unused directive, which is how a rule that quietly
 * stopped holding shows up.
 *
 * Imports `../src/app/index.js` directly because the app model is not re-exported from the package
 * root until the old `Component` and `ApiOf` names are deleted (phase 5).
 */

import { z } from 'zod';
import { element, text, type Node } from '../src/index.js';
import { needs } from '../src/contribution/capabilities.js';
import { App, Component, command, props, Router, Service, View } from '../src/app/index.js';

const nothing = (): Node => element('Stack', { children: [] });

// ---------------------------------------------------------------------------- services

const SessionSchema = z.object({ user: z.string(), token: z.string() });

class AuthService extends Service({ needs: needs('storage') }) {
    readonly signIn = command({
        title: 'Sign in',
        input: z.object({ email: z.string().email(), password: z.string().min(1) }),
        output: SessionSchema,
        run: async ({ email }) => ({ user: email, token: 't' }),
    });

    readonly signOut = command({ title: 'Sign out', run: () => undefined });

    touchesStorage(): void {
        void this.cx.storage;
    }

    touchesMesh(): void {
        // @ts-expect-error AuthService did not declare 'mesh', so cx has no such key
        void this.cx.mesh;
    }
}

class CartService extends Service({ inject: { auth: AuthService } }) {
    whoIsBuying(): Promise<void> {
        // An injected service is its real class, commands and all.
        return this.inject.auth.signOut.run();
    }

    wrongName(): void {
        // @ts-expect-error nothing named 'session' was injected
        void this.inject.session;
    }
}
void CartService;

// A service can only inject one declared before it, because `extends Service({ inject })` is
// evaluated where the class is written. A cycle needs one side to inject forwards, so none can be
// written — which is why the kernel's cycle check is a backstop, not the rule.
// @ts-expect-error Late is used before its declaration
class Early extends Service({ inject: { late: Late } }) {}
class Late extends Service({}) {}
void Early;

// ---------------------------------------------------------------------------- commands

export function commandRules(auth: AuthService): void {
    void auth.signIn.run({ email: 'a@b.c', password: 'x' });

    // @ts-expect-error input is checked against the schema: 'pass' is not 'password'
    void auth.signIn.run({ email: 'a@b.c', pass: 'x' });

    // @ts-expect-error a command with an input schema must be given input
    void auth.signIn.run();

    // @ts-expect-error a command with no input takes none
    void auth.signOut.run(1);

    const signedIn: Promise<{ user: string; token: string }> = auth.signIn.run({ email: 'a@b.c', password: 'x' });
    void signedIn;

    // @ts-expect-error run must return what the output schema says: 42 is not a string
    command({ title: 'Wrong output', output: z.string(), run: () => 42 });
}

// ---------------------------------------------------------------------------- components

class LoginForm extends Component({
    inject: { auth: AuthService },
    props: props<{ onDone: () => void; heading?: string }>(),
}) {
    render(): Node {
        return element('Button', {
            intents: { activate: { action: this.on(() => this.props.onDone()) } },
            children: [text(this.props.heading ?? 'Sign in')],
        });
    }
}

class Spinner extends Component({}) {
    render(): Node { return nothing(); }
}

class ZoneList extends Component({ needs: needs('mesh') }) {
    render(): Node { return nothing(); }
}

class Uploader extends Component({ needs: needs('storage') }) {
    render(): Node { return nothing(); }
}

class Panel extends Component({ needs: needs('mesh') }) {
    render(): Node {
        return element('Stack', {
            children: [
                this.mount(ZoneList),
                // @ts-expect-error Panel has 'mesh' only; Uploader needs 'storage' — capabilities only narrow going down
                this.mount(Uploader),
            ],
        });
    }
}
void Panel;

// ---------------------------------------------------------------------------- views

class HomeView extends View({}) {
    render(): Node {
        return element('Stack', {
            children: [
                this.mount(Spinner),
                this.mount(LoginForm, { onDone: () => undefined }),
                // @ts-expect-error LoginForm requires its props
                this.mount(LoginForm),
                // @ts-expect-error onDone must be a function
                this.mount(LoginForm, { onDone: 1 }),
                // @ts-expect-error HomeView has no capabilities; ZoneList needs 'mesh'
                this.mount(ZoneList),
            ],
        });
    }
}

class RecordsView extends View({
    needs: needs('mesh', 'models'),
    params: z.object({ zone: z.string() }),
    query: z.object({ page: z.coerce.number().default(1) }),
}) {
    render(): Node {
        const zone: string = this.params.zone;
        const page: number = this.query().page;
        void zone; void page;
        // @ts-expect-error 'record' is not in RecordsView's params schema
        void this.params.record;
        // @ts-expect-error the query is `query()`, not a params field
        void this.params.page;
        return this.mount(ZoneList);
    }
}

class SettingsView extends View({ needs: needs('storage') }) {
    render(): Node { return nothing(); }
}

// @ts-expect-error a view must render — one without render() would mount and draw nothing, silently
export class Blank extends View({}) {}

// @ts-expect-error same for a component
export class BlankPart extends Component({}) {}

// ---------------------------------------------------------------------------- the app

export class Site extends App({
    needs: needs('mesh', 'models', 'storage'),
    services: [AuthService],
    routes: {
        '/': HomeView,
        '/domains/:zone/records': RecordsView,
        '/settings': SettingsView,
    },
}) {}

export class MissingParam extends App({
    needs: needs('mesh', 'models'),
    routes: {
        // @ts-expect-error ':record' is not in RecordsView's params
        '/domains/:zone/records/:record': RecordsView,
    },
}) {}

class PagedByParams extends View({
    params: z.object({ zone: z.string(), page: z.coerce.number() }),
}) {
    render(): Node { return nothing(); }
}

export class ExtraParam extends App({
    routes: {
        // @ts-expect-error `page` is not in the path, so it could never be filled — it belongs in `query`
        '/domains/:zone': PagedByParams,
    },
}) {}

export class MissingNeed extends App({
    needs: needs('mesh', 'models'),
    routes: {
        // @ts-expect-error SettingsView needs 'storage', which this app was not granted
        '/settings': SettingsView,
    },
}) {}

export class ParamOnParamlessView extends App({
    routes: {
        // @ts-expect-error HomeView declares no params, so a ':id' route cannot mount it
        '/things/:id': HomeView,
    },
}) {}

// ---------------------------------------------------------------------------- links

export class Nav extends Component({ inject: { router: Router } }) {
    render(): Node {
        const { router } = this.inject;
        router.href(HomeView);
        router.href(RecordsView, { zone: 'example.com' });          // `page` has a default, so optional
        router.href(RecordsView, { zone: 'example.com', page: 2 });

        // @ts-expect-error RecordsView needs `zone`
        router.href(RecordsView, {});
        // @ts-expect-error RecordsView takes params, so they must be given
        router.href(RecordsView);
        // @ts-expect-error HomeView takes no params
        router.href(HomeView, { zone: 'example.com' });
        // @ts-expect-error `page` is a number
        router.href(RecordsView, { zone: 'example.com', page: 'two' });
        // @ts-expect-error `pgae` is neither a param nor a query field
        router.href(RecordsView, { zone: 'example.com', pgae: 2 });
        return nothing();
    }
}

// ---------------------------------------------------------------------------- statics are readable

export const manifest = {
    routes: Object.keys(Site.spec.routes),
    services: Site.spec.services,
    recordsNeeds: RecordsView.spec.needs,
    loginInjects: LoginForm.spec.inject,
} as const;
