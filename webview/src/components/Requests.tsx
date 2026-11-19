import { useState } from 'preact/hooks';
import type { PermissionRequest, QuestionRequest } from '../../../src/shared/types';
import { send } from '../store';

/** Permission and question prompts raised by the agent; pinned above the composer until answered. */
export function Requests({ permissions, questions }: { permissions: PermissionRequest[]; questions: QuestionRequest[] }) {
  if (permissions.length === 0 && questions.length === 0) return null;
  return (
    <div class="requests">
      {permissions.map((p) => (
        <div class="request" key={p.id} role="alertdialog" aria-label={p.title}>
          <div class="request-title">{p.title}</div>
          {p.detail && <pre class="request-detail">{p.detail}</pre>}
          <div class="request-actions">
            <button type="button" class="btn primary" onClick={() => send({ type: 'permissionReply', requestId: p.id, reply: 'once' })}>
              Allow once
            </button>
            <button type="button" class="btn" onClick={() => send({ type: 'permissionReply', requestId: p.id, reply: 'always' })}>
              Always allow
            </button>
            <button type="button" class="btn quiet" onClick={() => send({ type: 'permissionReply', requestId: p.id, reply: 'reject' })}>
              Deny
            </button>
            <button type="button" class="btn quiet auto-switch" title="Approve this and everything after it without asking (/ask switches back)" onClick={() => send({ type: 'setApprovals', mode: 'auto' })}>
              Switch to Auto
            </button>
          </div>
        </div>
      ))}
      {questions.map((q) => (
        <Question key={q.id} request={q} />
      ))}
    </div>
  );
}

function Question({ request }: { request: QuestionRequest }) {
  const [answers, setAnswers] = useState<string[][]>(() => request.questions.map(() => []));
  const toggle = (qi: number, label: string, multiple: boolean | undefined) =>
    setAnswers((prev) => prev.map((a, i) => (i !== qi ? a : multiple ? (a.includes(label) ? a.filter((x) => x !== label) : [...a, label]) : [label])));
  const complete = answers.every((a) => a.length > 0);
  return (
    <div class="request" role="dialog" aria-label="Question from the agent">
      {request.questions.map((q, qi) => (
        <div class="question" key={qi}>
          <div class="request-title">{q.question}</div>
          <div class="options">
            {q.options.map((o) => (
              <button type="button" key={o.label} class={`option ${answers[qi].includes(o.label) ? 'selected' : ''}`} aria-pressed={answers[qi].includes(o.label)} title={o.description} onClick={() => toggle(qi, o.label, q.multiple)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div class="request-actions">
        <button type="button" class="btn primary" disabled={!complete} onClick={() => send({ type: 'questionReply', requestId: request.id, answers })}>
          Send answer
        </button>
        <button type="button" class="btn quiet" onClick={() => send({ type: 'questionReply', requestId: request.id, answers: null })}>
          Skip
        </button>
      </div>
    </div>
  );
}
