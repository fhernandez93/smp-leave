import { useState } from "react";
import { DEFAULT_SETTINGS } from "../../domain/calendar";
import { createTeam, toast } from "../../state/actions";
import { useApp } from "../../state/store";

export function Setup() {
  const [s, d] = useApp();
  const [teamName, setTeamName] = useState(DEFAULT_SETTINGS.teamName);
  const [days, setDays] = useState(String(DEFAULT_SETTINGS.defaultDays));
  const [thr, setThr] = useState(String(DEFAULT_SETTINGS.approvalThreshold));
  const [people, setPeople] = useState<{ key: number; name: string; role: "member" | "manager" }[]>([
    { key: 1, name: s.myName, role: "manager" }, { key: 2, name: "", role: "member" }, { key: 3, name: "", role: "member" },
  ]);
  const [busy, setBusy] = useState(false);

  if (!s.isAdmin || d.readOnly) {
    return (
      <div className="gate">
        <h2>Nothing set up yet</h2>
        <p>The team roster is empty. Ask whoever owns this tracker to add the group.</p>
      </div>
    );
  }

  const go = async () => {
    const list = people.map((p) => ({ name: p.name.trim(), role: p.role })).filter((p) => p.name);
    if (!list.length) return toast("Add at least one person.", true);
    setBusy(true);
    await createTeam(teamName.trim(), Number(days) || 0, Number(thr) || 0, list);
    setBusy(false);
  };

  return (
    <div className="setup">
      <div className="panel">
        <div className="hd"><h2>Set up leave tracking</h2></div>
        <div className="pad">
          <p className="muted small" style={{ marginTop: 0 }}>A few details to start with. Everything here can be changed later in Settings.</p>
          <label className="field"><span>Team name</span><input id="setup-team" type="text" value={teamName} onChange={(e) => setTeamName(e.target.value)} /></label>
          <div className="row2">
            <label className="field"><span>Annual vacation days per person</span><input id="setup-days" type="number" min="0" max="60" step="0.5" value={days} onChange={(e) => setDays(e.target.value)} /></label>
            <label className="field"><span>Days a person can book without approval</span><input id="setup-thr" type="number" min="0" max="30" step="0.5" value={thr} onChange={(e) => setThr(e.target.value)} /></label>
          </div>
          <p className="tiny dim" style={{ margin: "-4px 0 0" }}>Anything longer than this goes to an approver. Sick leave and remote days are always logged directly.</p>
        </div>
      </div>
      <div className="panel">
        <div className="hd"><h2>Who is on the team</h2></div>
        <div className="mlist">
          {people.map((p, i) => (
            <div className="mrow" key={p.key}>
              <div className="nm">
                <input type="text" aria-label={`Person ${i + 1}`} placeholder="Full name" value={p.name}
                  onChange={(e) => setPeople(people.map((x) => (x.key === p.key ? { ...x, name: e.target.value } : x)))} />
              </div>
              <label className="check" style={{ margin: 0 }}>
                <input type="checkbox" checked={p.role === "manager"} onChange={(e) => setPeople(people.map((x) => (x.key === p.key ? { ...x, role: e.target.checked ? "manager" : "member" } : x)))} />
                <span>Approves leave</span>
              </label>
              <button className="btn sm ghost" type="button" onClick={() => setPeople(people.filter((x) => x.key !== p.key))}>Remove</button>
            </div>
          ))}
          <div className="mrow">
            <button className="btn sm" type="button" onClick={() => setPeople([...people, { key: Date.now(), name: "", role: "member" }])}>Add another person</button>
          </div>
        </div>
      </div>
      <div style={{ marginTop: 18, display: "flex", gap: 10, alignItems: "center" }}>
        <button className="btn primary" type="button" disabled={busy} onClick={() => void go()}>Create the team</button>
        <span className="tiny dim">You can pull the rest of the group straight out of your Claude team afterwards.</span>
      </div>
    </div>
  );
}
