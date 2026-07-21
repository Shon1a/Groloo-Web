import { Component, type ErrorInfo, type ReactNode } from 'react';
import { EN } from '../i18n/en';

/* The app's crash net. When a render throws, React unmounts the whole tree — in a
 * browser that is survivable (F5, the address bar, devtools), but on a TV it is
 * terminal: the remote has no reload, no URL bar and no back-out of a full-screen
 * app, so one bad field from a third-party add-on bricks the session until the user
 * kills the app from the launcher. A boundary is the only thing that can put a way
 * back on screen, so it renders a real focusable control rather than a message.
 *
 * Class component on purpose: getDerivedStateFromError / componentDidCatch still have
 * no hook equivalent in React 19, and there is no sign of one coming.
 *
 * The fallback borrows the auth overlay's classes instead of shipping its own: this is
 * the one path that must paint when the app is already broken, so it should depend on
 * as little new anything as possible — and the overlay is already a centred card with
 * a full-width primary button, which is exactly the shape of this screen. */

/* WHY THE DEFAULT PANEL READS THE BUNDLED EN MAP INSTEAD OF CALLING t().
 * The root boundary is mounted OUTSIDE <I18nProvider> in main.tsx, deliberately — a throw
 * from the provider's own setup has to land somewhere, and it cannot land inside itself.
 * So useT() is unavailable here twice over: no context, and no hooks in a class anyway.
 * That leaves the copy below in whatever language the bundle ships, which is the honest
 * trade for a panel that must paint when the app has already failed; going through the
 * live dictionary would mean the crash screen depends on the subsystem that may be the
 * thing that crashed. The strings still come from the key map rather than being inlined,
 * so an edit to the wording happens in one file and the translators still see the keys.
 *
 * The lookup is wrapped because a fallback may not throw: React escalates a throw inside
 * a boundary's fallback to the NEXT boundary up, and this one is the last — the whole app
 * would unmount with nothing on screen, which is precisely the outcome this class exists
 * to prevent. EN is a plain object literal and cannot realistically throw, but "cannot
 * realistically" is not a property worth betting the only crash screen on. It is also
 * already a hard dependency of the entry chunk (i18n.tsx imports it), so reading it here
 * adds no new way for the boundary itself to fail to load. Callers that live inside the
 * provider (AddonRows) pass a translated `fallback` node instead, resolving t() in the
 * parent where it is safe. */
const en = (key: string, literal: string): string => {
  try { return EN[key] || literal; } catch { return literal; }
};

export interface ErrorBoundaryProps {
  children: ReactNode;
  /* Replaces the full-screen panel. Per-row boundaries pass a compact node so a dead
   * add-on degrades to one inert rail instead of covering the home screen. */
  fallback?: ReactNode;
  /* Names the subtree in the logged line — 'catalog row: Cinemeta Top' is actionable,
   * 'a component threw' is not. */
  label?: string;
}

interface ErrorBoundaryState { error: Error | null }

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Same '[groloo]' prefix as the window-level handlers in main.tsx, so every crash in
    // the app is one console filter away. The component stack is logged separately because
    // it is the one part React does not fold into error.stack — and the only part that
    // says which row/screen died when the message itself is a generic TypeError.
    const where = this.props.label ? ` in ${this.props.label}` : '';
    console.error(`[groloo] render error${where}:`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return (
      // .open is set from the start (never animated in) — the fade-in classes exist only so
      // the card inherits its final opacity/transform; a fallback that waits on a transition
      // to become visible is a fallback that can fail the same way the app just did.
      <div className="auth-overlay open" role="alert">
        <div className="auth-card">
          <div className="auth-word">{en('error.title', 'Something went wrong')}</div>
          <p className="auth-kicker">{en('error.body', 'Groloo hit an unexpected error and stopped drawing this screen.')}</p>
          {/* autoFocus is the whole point on a TV: the remote has nothing to click with, so the
              only control here must already hold focus when the panel appears. It is a real
              <button>, so the global button:focus-visible ring in app.css draws itself. */}
          <button className="auth-submit" type="button" autoFocus onClick={() => window.location.reload()}>
            {en('error.reload', 'RELOAD')}
          </button>
          <p className="auth-note">{this.props.label ? `${this.props.label} — ` : ''}{error.message || String(error)}</p>
        </div>
      </div>
    );
  }
}
