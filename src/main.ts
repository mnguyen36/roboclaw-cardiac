import './style.css';
import { App } from './app/App';

const root = document.getElementById('app');
if (!root) throw new Error('missing #app root');
const app = new App(root);
(window as unknown as { roboclaw: App }).roboclaw = app;

if (import.meta.env.DEV && new URLSearchParams(location.search).has('harness')) {
  void import('./dev/harness').then((m) => m.installHarness(app));
}
