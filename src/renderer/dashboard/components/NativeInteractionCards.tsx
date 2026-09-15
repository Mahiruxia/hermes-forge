import { useRef, useState } from "react";
import type { ApprovalChoice, ApprovalRequest, ClarifyRequest, EngineInteractionQuestion } from "../../../shared/types";
import { useAppStore } from "../../store";

const CARD_CLASS = "rounded-2xl border border-slate-200/70 bg-white/80 px-4 py-3 shadow-[0_8px_24px_rgba(15,23,42,0.04)]";
const BUTTON_CLASS = "rounded-full border border-slate-200 px-3 py-1.5 text-[12px] font-semibold text-slate-600 disabled:cursor-wait disabled:opacity-50";
const PRIMARY_CLASS = `${BUTTON_CLASS} border-slate-900 bg-slate-900 text-white`;
const APPROVAL_LABELS: Record<ApprovalChoice, string> = { once: "本次允许", session: "本会话允许", always: "始终允许", deny: "拒绝" };

export function NativeApprovalCard({ card }: { card: ApprovalRequest }) {
  const resolveApprovalCard = useAppStore(state => state.resolveApprovalCard);
  const [command, setCommand] = useState(card.command ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const choices: ApprovalChoice[] = card.allowedChoices ?? ["once", "session", "always", "deny"];

  async function respond(choice: ApprovalChoice) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await window.workbenchClient.respondApproval({
        id: card.id,
        choice,
        ...(card.allowEdit === true && card.command !== undefined && choice !== "deny" ? { editedCommand: command } : {}),
      });
      if (!result.ok) throw new Error(result.message || "审批未被接受，请重试。");
      resolveApprovalCard(card.id, choice === "deny" ? "denied" : "approved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "审批操作失败，请重试。");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <section className={CARD_CLASS} aria-label={card.title}>
      <p className="text-[13px] font-semibold text-slate-800">{card.title}</p>
      {card.command !== undefined ? card.allowEdit === true ? (
        <label className="mt-2 block text-[12px] text-slate-600">待执行命令
          <textarea aria-label="待执行命令" className="mt-1 block w-full rounded-xl border border-slate-200 bg-slate-50 p-2 font-mono" value={command} onChange={event => setCommand(event.target.value)} disabled={busy} />
        </label>
      ) : <code className="mt-2 block whitespace-pre-wrap break-all rounded-xl bg-slate-50 p-2 text-[12px] text-slate-600">{card.command}</code> : null}
      {card.details ? <p className="mt-2 whitespace-pre-wrap text-[12px] text-slate-500">{card.details}</p> : null}
      {error ? <p role="alert" className="mt-2 text-[12px] text-red-700">{error}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {choices.map(choice => <button key={choice} type="button" disabled={busy} className={choice === "once" ? PRIMARY_CLASS : BUTTON_CLASS} onClick={() => void respond(choice)}>{choice === "session" && card.allowEdit === false ? "本轮允许" : APPROVAL_LABELS[choice]}</button>)}
      </div>
    </section>
  );
}

type Answer = string | string[];

export function NativeClarifyCard({ card }: { card: ClarifyRequest }) {
  const resolveClarifyCard = useAppStore(state => state.resolveClarifyCard);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const grouped = Boolean(card.questions?.length);
  const questions: EngineInteractionQuestion[] = grouped ? card.questions! : [{ id: "answer", question: card.question, choices: card.options, multiSelect: card.multiSelect }];
  const complete = questions.every(question => {
    const answer = answers[question.id];
    return Array.isArray(answer) ? answer.length > 0 && answer.every(item => item.trim()) : Boolean(answer?.trim());
  });

  async function respond(dismissed: boolean) {
    if (submitting.current || (!dismissed && !complete)) return;
    if (!card.taskRunId) {
      resolveClarifyCard(card.id, "dismissed");
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await window.workbenchClient.respondInteraction({
        requestId: card.id,
        taskRunId: card.taskRunId,
        kind: "clarify",
        ...(dismissed ? { timedOut: true } : grouped ? { answers: Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, typeof value === "string" ? value.trim() : value])) } : { answer: typeof answers.answer === "string" ? answers.answer.trim() : answers.answer }),
      });
      if (!result.ok) throw new Error(result.message || "回答未被接受，请重试。");
      resolveClarifyCard(card.id, dismissed ? "dismissed" : "answered");
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交回答失败，请重试。");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <section className={CARD_CLASS} aria-label="补充信息">
      <p className="whitespace-pre-wrap text-[13px] font-semibold text-slate-800">{card.question}</p>
      {card.taskRunId ? (
        <form onSubmit={event => { event.preventDefault(); void respond(false); }}>
          <div className="mt-3 grid gap-3">
            {questions.map(question => <QuestionField key={question.id} question={question} value={answers[question.id]} disabled={busy} onChange={value => setAnswers(current => ({ ...current, [question.id]: value }))} />)}
          </div>
          {error ? <p role="alert" className="mt-2 text-[12px] text-red-700">{error}</p> : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="submit" className={PRIMARY_CLASS} disabled={busy || !complete}>{busy ? "正在提交…" : "提交回答"}</button>
            <button type="button" className={BUTTON_CLASS} disabled={busy} onClick={() => void respond(true)}>跳过</button>
          </div>
        </form>
      ) : <button type="button" className={`${BUTTON_CLASS} mt-3`} onClick={() => void respond(true)}>关闭</button>}
    </section>
  );
}

function QuestionField({ question, value, disabled, onChange }: { question: EngineInteractionQuestion; value?: Answer; disabled: boolean; onChange: (value: Answer) => void }) {
  return (
    <fieldset disabled={disabled} className="min-w-0 text-[13px] text-slate-700">
      <legend className="mb-2 font-medium">{question.question}</legend>
      {question.choices?.length ? (
        <div className="flex flex-wrap gap-2">
          {question.choices.map(choice => {
            const checked = Array.isArray(value) ? value.includes(choice) : value === choice;
            return <label key={choice} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2">
              <input type={question.multiSelect ? "checkbox" : "radio"} name={question.id} value={choice} checked={checked} onChange={() => {
                if (!question.multiSelect) return onChange(choice);
                const selected = Array.isArray(value) ? value : [];
                onChange(checked ? selected.filter(item => item !== choice) : [...selected, choice]);
              }} />{choice}
            </label>;
          })}
        </div>
      ) : <textarea aria-label={question.question} rows={2} className="w-full rounded-xl border border-slate-200 p-2 disabled:opacity-50" value={typeof value === "string" ? value : ""} onChange={event => onChange(event.target.value)} />}
    </fieldset>
  );
}
