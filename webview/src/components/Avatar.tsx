import { useEffect, useRef } from 'preact/hooks';
import type { AvatarStyle } from '../../../src/shared/protocol';
import type { AvatarHandle } from '../avatar/index';
import type { Mood, WorkKind } from '../avatar/face';
import { takeReactions } from '../hooks';
import { send, store } from '../store';

let loading: Promise<void> | undefined;

/** The Three.js bundle is loaded on demand so the chat is interactive before it arrives. */
function loadAvatarBundle(): Promise<void> {
  if (window.OkiAvatar) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const src = document.getElementById('root')?.dataset.avatarSrc;
    if (!src) return reject(new Error('avatar bundle location missing'));
    const script = document.createElement('script');
    script.src = src;
    // Reuse the page's CSP nonce.
    script.nonce = (document.querySelector('script[nonce]') as HTMLScriptElement | null)?.nonce ?? '';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('avatar bundle failed to load'));
    document.head.appendChild(script);
  });
  return loading;
}

export function Avatar({ mood, work, style, poke }: { mood: Mood; work: WorkKind; style: AvatarStyle; poke: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const handle = useRef<AvatarHandle | undefined>(undefined);
  // The bundle loads asynchronously; keep the latest props so the avatar starts in the right state.
  const latest = useRef({ mood, style, work });
  latest.current = { mood, style, work };

  useEffect(() => {
    let cancelled = false;
    // Wait for an idle moment: the chat itself should be usable before the companion shows up.
    const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 60));
    idle(() => {
      loadAvatarBundle()
        .then(() => {
          if (cancelled || !canvas.current || !window.OkiAvatar) return;
          const light = document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light');
          handle.current = window.OkiAvatar.mount(canvas.current, { style: latest.current.style, mood: latest.current.mood, light });
          handle.current.setWork(latest.current.work);
          send({ type: 'avatarReady', renderer: handle.current.renderer });
        })
        .catch((err) => send({ type: 'log', level: 'warn', message: String(err) }));
    });
    // Text chunks make talking livelier.
    let seen = store.lastDelta;
    const off = store.subscribe(() => {
      if (store.lastDelta !== seen) {
        seen = store.lastDelta;
        handle.current?.pulse();
      }
    });
    return () => {
      cancelled = true;
      off();
      handle.current?.dispose();
      handle.current = undefined;
    };
  }, []);

  useEffect(() => handle.current?.setMood(mood), [mood]);
  useEffect(() => handle.current?.setWork(work), [work]);
  useEffect(() => handle.current?.setStyle(style), [style]);
  useEffect(() => {
    if (poke) handle.current?.react('poke');
  }, [poke]);
  // Tool results that arrived with this render: a little cheer or a wince.
  useEffect(() => {
    for (const r of takeReactions()) handle.current?.react(r);
  });

  return <canvas ref={canvas} class="oki" data-mood={mood} role="img" aria-label={`Companion: ${mood}`} />;
}
