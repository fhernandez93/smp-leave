import { useState } from "react";
import { addMember, askToJoin, blankMember, claimMember, withdrawJoin } from "../../state/actions";
import { nameOf, useApp } from "../../state/store";

export function Identity() {
  const [s, d] = useApp();
  const [name, setName] = useState(s.myName);
  const waiting = !!s.uid && s.joiners.some((j) => j.uid === s.uid);

  if (waiting) {
    return (
      <div className="panel" style={{ maxWidth: 430, margin: "10vh auto" }}>
        <div className="hd"><h2>Waiting to be added</h2></div>
        <div className="pad muted small">
          <p style={{ marginTop: 0 }}>An Editor has to confirm you before your leave shows up here. You’ll see the tracker as soon as they do.</p>
          <button className="btn sm" type="button" onClick={() => void withdrawJoin()}>Withdraw the request</button>
        </div>
      </div>
    );
  }

  const guess = s.myName.toLowerCase();
  const taken = (id: string) => {
    const u = d.model.bindings.uidOf.get(id);
    return (!!u && u !== s.uid) || d.model.bindings.contested.has(id);
  };
  const offered = d.activeMembers
    .filter((m) => !taken(m.id))
    .sort((a, b) => {
      const am = nameOf(s, d, a.id).toLowerCase() === guess ? 0 : 1;
      const bm = nameOf(s, d, b.id).toLowerCase() === guess ? 0 : 1;
      return am - bm || nameOf(s, d, a.id).localeCompare(nameOf(s, d, b.id));
    });

  return (
    <div className="panel" style={{ maxWidth: 460, margin: "8vh auto" }}>
      <div className="hd"><h2>Which one are you?</h2></div>
      <div className="pad" style={{ paddingBottom: 4 }}>
        <p className="muted small" style={{ margin: 0 }}>Pick your name so the tracker knows whose leave to show. You only do this once.</p>
      </div>
      <div className="mlist">
        {offered.length === 0 && <div className="empty">Everyone on the roster is already matched to an account.</div>}
        {offered.map((m) => (
          <div className="mrow" key={m.id}>
            <div className="nm">{nameOf(s, d, m.id)}</div>
            {m.role === "manager" && <span className="pill mgr">Approver</span>}
            <button className="btn sm" type="button" onClick={() => void claimMember(m.id)}>That’s me</button>
          </div>
        ))}
      </div>
      {s.isAdmin && !d.readOnly ? (
        <div className="pad" style={{ borderTop: "1px solid var(--line)" }}>
          <label className="field"><span>Not listed? Add yourself</span><input id="self-name" type="text" placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <button className="btn" type="button" onClick={() => {
            const n = name.trim();
            if (!n) return;
            // the new entry carries this account's id, so it is "me" as soon as the roster updates
            void addMember(blankMember({ name: s.myName && n === s.myName ? "" : n, nameHint: n, uid: s.uid, source: "self" }), "Added you to the team")
              .then((id) => { if (id && !s.uid) void claimMember(id); });
          }}>Add me to the team</button>
        </div>
      ) : s.uid && !d.readOnly ? (
        <div className="pad" style={{ borderTop: "1px solid var(--line)" }}>
          <p className="muted small" style={{ margin: "0 0 10px" }}>Not on the list? Ask the Editors to add you — they confirm it from the Team tab.</p>
          <button className="btn primary" type="button" onClick={() => void askToJoin()}>Ask to be added</button>
        </div>
      ) : null}
    </div>
  );
}
