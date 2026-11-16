import { useEffect, useRef, useState, type ReactNode } from "react";
import { closeModal } from "../../state/actions";
import { useApp, type ModalSpec } from "../../state/store";
import { Booking } from "./Booking";
import { Overtime } from "./Overtime";
import { RequestDetail } from "./RequestDetail";
import { AddPeople, Import } from "./AddPeople";

export function ModalHost() {
  const [s] = useApp();
  const m = s.modal;
  if (!m) return <div id="modalHost" />;
  return <div id="modalHost">{render(m)}</div>;
}

function render(m: ModalSpec): ReactNode {
  switch (m.kind) {
    case "booking": return <Booking start={m.start} />;
    case "overtime": return <Overtime date={m.date} />;
    case "request": return <RequestDetail uid={m.uid} />;
    case "addPeople": return <AddPeople initialTab={m.tab} seed={m.seed} />;
    case "import": return <Import people={m.people} />;
    case "ask": return <Ask spec={m} />;
  }
}

export function Modal({ title, children, foot }: { title: string; children: ReactNode; foot?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // focus the first field; give focus back to whatever opened the dialog when it closes
    const opener = document.activeElement as HTMLElement | null;
    const first = box.current?.querySelector<HTMLElement>(".bd select,.bd input,.bd textarea,.bd button") ?? box.current?.querySelector<HTMLElement>(".ft .btn.primary,.ft .btn.danger")
      ?? box.current?.querySelector<HTMLElement>(".ft .btn,.hd button");
    // don't steal focus from a field the person (or a test) already moved into
    const t = setTimeout(() => { if (!box.current?.contains(document.activeElement)) first?.focus(); }, 30);
    return () => {
      clearTimeout(t);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);
  /** keep Tab inside the dialog */
  const trap = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>("button:not([disabled]),input:not([disabled]),select,textarea,a[href]")];
    if (!items.length) return;
    const first = items[0]!, last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  return (
    <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={box} onKeyDown={trap}>
        <div className="hd">
          <h2>{title}</h2>
          <span className="spacer" />
          <button className="btn sm ghost" type="button" aria-label="Close" onClick={closeModal}>✕</button>
        </div>
        <div className="bd">{children}</div>
        {foot && <div className="ft">{foot}</div>}
      </div>
    </div>
  );
}

/** One small dialog for confirmations and single-field questions (browsers block confirm/prompt in artifacts). */
function Ask({ spec }: { spec: Extract<ModalSpec, { kind: "ask" }> }) {
  const [value, setValue] = useState(spec.value ?? "");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const run = async () => {
    const v = value.trim();
    if (spec.required && !v) { input.current?.focus(); return; }
    setBusy(true);
    try { await spec.onOk(v); } finally { setBusy(false); }
    closeModal();
  };
  return (
    <Modal title={spec.title} foot={<>
      <span className="spacer" />
      <button className="btn" type="button" onClick={closeModal}>Back</button>
      <button className={"btn " + (spec.danger ? "danger" : "primary")} type="button" disabled={busy} onClick={() => void run()}>{spec.ok ?? "OK"}</button>
    </>}>
      {spec.text && <p className="muted small" style={{ margin: "0 0 4px" }}>{spec.text}</p>}
      {spec.label && (
        <label className="field" style={{ marginBottom: 0 }}>
          <span>{spec.label}</span>
          <input id="ask-input" ref={input} type="text" value={value} placeholder={spec.placeholder ?? ""} maxLength={500}
            onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void run(); }} />
        </label>
      )}
    </Modal>
  );
}
