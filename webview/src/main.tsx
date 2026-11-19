import { render } from 'preact';
import { App } from './App';
import { send } from './store';
import './styles.css';

window.addEventListener('error', (e) => send({ type: 'log', level: 'error', message: `${e.message} (${e.filename}:${e.lineno})` }));
window.addEventListener('unhandledrejection', (e) => send({ type: 'log', level: 'error', message: `Unhandled rejection: ${String(e.reason)}` }));

render(<App />, document.getElementById('root')!);
send({ type: 'ready' });
