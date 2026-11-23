import { useState } from "react";
import { num } from "../../domain/dates";
import { autoCarry, balance, carryover, carryStart, entitlement } from "../../domain/model";
import { yearOf } from "../../domain/dates";
import type { Member } from "../../domain/types";
import { acceptJoiner, claimLooksRight, dismissJoiner, openModal, pin, unlink, updateMember } from "../../state/actions";
import { displayName, nameOf, useApp, type Derived, type State } from "../../state/store";
import { Avatar, YearPicker } from "../common";

/** What an Editor still has to look at: join requests, contested names, and people who left the Claude team. */
export function reviewQueue(s: State, d: Derived) {
  const uidOf = (m: Member) => m.uid || d.model.bindings.uidOf.get(m.id) || null;
  const joiners = s.joiners.filter((j) => !s.members.some((m) => uidOf(m) === j.uid));
  const contested = [...d.model.bindings.contested.entries()];
  // only trust a missing name when the directory is demonstrably answering for someone else
  const working = s.members.some((m) => {
    const u = uidOf(m);
    return u && u !== s.uid && s.profiles[u]?.name;
  });
  const cutoff = new Date(Date.now() - 86_400_000).toISOString();
  const leavers = !working ? [] : s.members.filter((m) => {
    const u = uidOf(m);
    return !m.archived && u && u !== s.uid && !m.keepUnresolved && (m.addedAt ?? "") < cutoff && s.profiles[u] && s.profiles[u].name === "";
  });
  const ignored = d.model.ignored.length;
  // claims an Editor's page didn't confirm automatically (the account name doesn't match the roster name)
  const unconfirmed = [...d.model.bindings.unconfirmed]
    .map((memberId) => ({ memberId, uid: d.model.bindings.uidOf.get(memberId)! }))
    .filter(({ memberId, uid }) => uid && !claimLooksRight(memberId, uid));
  return { joiners, contested, leavers, unconfirmed, ignored, total: joiners.length + contested.length + leavers.length + unconfirmed.length };
}

export function Team() {
  const [s, d] = useApp();
  const editable = s.isAdmin && !d.readOnly;
  const q = reviewQueue(s, d);
  const y = s.year;
  const sorted = [...s.members].sort((a, b) => Number(a.archived) - Number(b.archived) || nameOf(s, d, a.id).localeCompare(nameOf(s, d, b.id)));
  const profileName = (uid: string) => s.profiles[uid]?.name || "an unnamed account";

  return (
    <>
      {editable && (q.total > 0 || q.ignored > 0) && (
        <div className="panel">
          <div className="hd"><h2>Changes to confirm</h2><span className="spacer" /><span className="badge">{q.total}</span></div>
          <div className="mlist">
            {q.joiners.map((j) => {
              const nm = s.profiles[j.uid]?.name || j.nameHint || "Someone";
              return (
                <div className="mrow" key={j.uid}>
                  <Avatar uid={j.uid} />
                  <div className="nm">
                    <div>{nm}<span className="dim"> asked to join</span></div>
                    <div className="tiny dim">{s.profiles[j.uid]?.email || "Opened the tracker and isn’t on the roster yet"}</div>
                  </div>
                  <button className="btn sm primary" type="button" onClick={() => void acceptJoiner(j.uid, nm)}>Add to the team</button>
                  <button className="btn sm ghost" type="button" onClick={() => void dismissJoiner(j.uid)}>Dismiss</button>
                </div>
              );
            })}
            {q.contested.map(([memberId, uids]) => (
              <div className="mrow" key={memberId}>
                <div className="nm">
                  <div>{nameOf(s, d, memberId)}<span className="dim"> was picked by {uids.length} accounts</span></div>
                  <div className="tiny dim">Their bookings count once you confirm which account is theirs.</div>
                </div>
                {uids.map((u) => (
                  <button key={u} className="btn sm" type="button" onClick={() => void pin(memberId, u)}>It’s {profileName(u)}</button>
                ))}
              </div>
            ))}
            {q.unconfirmed.map(({ memberId, uid }) => (
              <div className="mrow" key={memberId}>
                <Avatar uid={uid} />
                <div className="nm">
                  <div>{nameOf(s, d, memberId)}<span className="dim"> was picked by the account “{profileName(uid)}”</span></div>
                  <div className="tiny dim">Their bookings count already. Confirm it, or unlink it if that isn’t them.</div>
                </div>
                <button className="btn sm primary" type="button" onClick={() => void pin(memberId, uid)}>Confirm</button>
                <button className="btn sm ghost" type="button" onClick={() => void unlink(memberId)}>Unlink</button>
              </div>
            ))}
            {q.leavers.map((m) => (
              <div className="mrow" key={m.id}>
                <Avatar uid={m.uid || d.model.bindings.uidOf.get(m.id)} />
                <div className="nm">
                  <div>{nameOf(s, d, m.id)}<span className="dim"> no longer appears in your Claude team</span></div>
                  <div className="tiny dim">Archiving keeps their past leave in the records but takes them off the timeline.</div>
                </div>
                <button className="btn sm" type="button" onClick={() => void updateMember(m.id, { archived: true, leftAt: new Date().toISOString() }, "Archived")}>Archive</button>
                <button className="btn sm ghost" type="button" onClick={() => void updateMember(m.id, { keepUnresolved: true }, "Kept")}>Keep them</button>
              </div>
            ))}
            {q.ignored > 0 && (
              <div className="pad tiny dim">
                {q.ignored} {q.ignored === 1 ? "entry was" : "entries were"} booked under a name that doesn’t belong to the account that wrote {q.ignored === 1 ? "it" : "them"}, and {q.ignored === 1 ? "is" : "are"} ignored.
              </div>
            )}
          </div>
        </div>
      )}

      <div className="panel">
        <div className="hd">
          <h2>Team roster</h2>
          <span className="spacer" />
          <YearPicker />
          {editable && <button className="btn sm primary" type="button" onClick={() => openModal({ kind: "addPeople" })}>Add people</button>}
        </div>
        {y === s.settings.carryFrom && (
          <div className="pad small" style={{ color: "var(--warn)" }} data-testid="carry-manual-note">
            Carry-overs into {y} start at 0 for everyone and are <b>not</b> worked out automatically: {editable
              ? <>if someone should bring days (or a minus) from {y - 1} into {y}, enter it under “Adjust ±” with {y} selected. Each row shows how {y - 1} ended.</>
              : <>an Editor enters any days (or minus) brought from {y - 1}.</>}
            {" "}From {y + 1} on, whatever is left at the end of a year carries over by itself.
          </div>
        )}
        <div className="mlist">
          {sorted.map((m) => {
            const b = balance(d.cal, d.model, m, y);
            const u = m.uid || d.model.bindings.uidOf.get(m.id) || null;
            const unresolved = !!u && !!s.profiles[u] && s.profiles[u].name === "";
            const claimedBy = !m.uid && u ? profileName(u) : null;
            return (
              <div className="mrow" key={m.id} style={m.archived ? { opacity: 0.55 } : undefined} data-testid={`member-${m.id}`}>
                <Avatar uid={u} />
                <div className="nm">
                  <div>{displayName(s, m, (id) => d.model.bindings.uidOf.get(id))}{m.id === d.memberId && <span className="dim"> (you)</span>}</div>
                  <div className="tiny dim num">{num(b.taken)} taken, {num(b.left)} left in {y}</div>
                  {claimedBy && <div className="tiny dim">Picked by the account “{claimedBy}”</div>}
                </div>
                {m.role === "manager" && <span className="pill mgr">Approves leave</span>}
                {m.archived ? <span className="pill">Archived</span>
                  : !u ? <span className="pill" title="Not matched to a Claude account yet">Not linked</span>
                  : unresolved ? <span className="pill" title="Their Claude profile no longer resolves">Not found</span> : null}
                {editable && <MemberControls m={m} y={y} linkedUid={u} />}
              </div>
            );
          })}
        </div>
        {editable ? (
          <div className="pad tiny dim">
            Pull people out of your Claude team, or type them in by hand — <button className="btn sm ghost" style={{ padding: "1px 6px" }} type="button" onClick={() => openModal({ kind: "addPeople" })}>add people</button>.
            {" "}Approvers decide leave from their own page, which needs Editor access in the share menu.
          </div>
        ) : (
          <div className="pad tiny dim">Only an Editor of this tracker can change the roster.</div>
        )}
        {d.approverCount === 0 && (
          <div className="pad small" style={{ color: "var(--warn)" }}>Nobody is marked as an approver yet. Mark at least one person, or long requests will sit unanswered.</div>
        )}
      </div>
    </>
  );
}

function MemberControls({ m, y, linkedUid }: { m: Member; y: number; linkedUid: string | null }) {
  const [s, d] = useApp();
  const ent = entitlement(d.cal, m, y);
  const adj = carryover(m, y);
  const automatic = y - 1 >= carryStart(d.cal, m);
  const auto = automatic ? autoCarry(d.cal, d.model, m, y) : 0;
  const archivedPrev = s.settings.archivedBefore != null && y - 1 < s.settings.archivedBefore;
  const prevLeft = automatic ? auto : archivedPrev ? d.model.yearEnds.get(y - 1)?.[m.id] ?? null : balance(d.cal, d.model, m, y - 1).left;
  // before carry-over starts, show how the previous year ended (if it was tracked) so an Editor can carry it by hand
  const tracked = !!m.addedAt && yearOf(m.addedAt) <= y - 1;
  const hint = automatic
    ? `${auto >= 0 ? "+" : ""}${num(auto)} from ${y - 1} automatically`
    : tracked && prevLeft != null ? `${y - 1} ended at ${num(prevLeft)}, not carried automatically` : `nothing carried from ${y - 1} automatically`;
  return (
    <>
      <NumberField label="Days" id={`ent-${m.id}`} value={ent} min={0} max={90} title={`Vacation days for ${y}`}
        onCommit={(v) => updateMember(m.id, { entitlements: { ...m.entitlements, [y]: v } }, "Entitlement updated")} />
      <NumberField label="Adjust ±" id={`carry-${m.id}`} value={adj} min={-60} max={60}
        title={`Days added to ${y} on top of what carries over automatically (${hint}). 0 = no adjustment.`}
        onCommit={(v) => updateMember(m.id, { carryover: { ...m.carryover, [y]: v } }, "Adjustment saved")} />
      <span className="tiny dim num" data-testid={`carry-hint-${m.id}`}>{hint}</span>
      <button className="btn sm ghost" type="button" onClick={() => void updateMember(m.id, { role: m.role === "manager" ? "member" : "manager" }, m.role === "manager" ? "No longer approves leave" : "Now marked as an approver")}>
        {m.role === "manager" ? "Remove approver" : "Make approver"}
      </button>
      <button className="btn sm ghost" type="button" onClick={() => openModal({
        kind: "ask", title: linkedUid ? "Override the name" : "Rename",
        text: linkedUid ? "Leave this empty to follow their Claude profile instead." : "",
        label: "Full name", value: m.name || nameOf(s, d, m.id), ok: "Save", required: !linkedUid,
        onOk: (name) => updateMember(m.id, { name }, name ? "Renamed" : "Following their Claude profile"),
      })}>{m.name ? "Edit name" : linkedUid ? "Override name" : "Rename"}</button>
      {linkedUid && (
        <button className="btn sm ghost" type="button" onClick={() => void unlink(m.id)}>Unlink account</button>
      )}
      <button className="btn sm ghost" type="button" onClick={() => void updateMember(m.id, { archived: !m.archived, keepUnresolved: false }, m.archived ? "Restored" : "Archived")}>
        {m.archived ? "Restore" : "Archive"}
      </button>
    </>
  );
}

/**
 * A number the user edits freely and that is saved once, when they leave the
 * field or press Enter (never per keystroke — v2's first draft saved "3" while
 * someone was typing "30").
 */
function NumberField({ label, id, value, min, max, title, onCommit }: {
  label: string; id: string; value: number; min: number; max: number; title: string; onCommit: (v: number) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value);
  const commit = () => {
    if (draft == null) return;
    const v = Number(draft);
    setDraft(null);
    if (draft.trim() === "" || !Number.isFinite(v) || v === value) return;
    void onCommit(Math.min(max, Math.max(min, v)));
  };
  return (
    <label className="tiny dim" style={{ display: "flex", gap: 6, alignItems: "center" }}>{label}
      <input id={id} className="ent num" type="number" step="0.5" min={min} max={max} title={title} value={shown}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setDraft(null); }} />
    </label>
  );
}
