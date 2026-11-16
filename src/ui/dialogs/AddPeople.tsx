import { useEffect, useState } from "react";
import type { Profile } from "../../platform/runtime";
import { addMember, blankMember, closeModal, openModal, toast } from "../../state/actions";
import { nameOf, store, useApp } from "../../state/store";
import { Modal } from "./ModalHost";

function AvatarFor({ p }: { p: Profile | null }) {
  if (!p?.avatarUrl) return <span style={{ width: 26, height: 26, borderRadius: "50%", flex: "0 0 auto", background: "var(--surface-3)" }} />;
  return <img src={p.avatarUrl} alt="" width={26} height={26} loading="lazy" style={{ borderRadius: "50%", flex: "0 0 auto" }} />;
}

function onRoster(): Set<string> {
  const s = store.get();
  const ids = new Set<string>();
  for (const m of s.members) if (m.uid) ids.add(m.uid);
  return ids;
}

export function AddPeople({ initialTab, seed }: { initialTab?: "team" | "name"; seed?: string }) {
  const [s, d] = useApp();
  const [tab, setTab] = useState<"team" | "name">(initialTab ?? (s.user ? "team" : "name"));
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Profile[]>([]);
  const [answered, setAnswered] = useState(false);
  const [names, setNames] = useState(seed ?? "");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const user = s.user;
    if (!user) return;
    let live = true;
    user.search(q).then((h) => { if (live) { setHits(h); if (h.length) setAnswered(true); } }).catch(() => live && setHits([]));
    return () => { live = false; };
  }, [q, s.user]);

  const roster = onRoster();

  const addTyped = async () => {
    const have = new Set(s.members.map((m) => nameOf(s, d, m.id).toLowerCase()));
    const list = names.split("\n").map((x) => x.trim()).filter(Boolean).filter((n, i, all) => all.indexOf(n) === i && !have.has(n.toLowerCase()));
    if (!list.length) return toast("Everyone on that list is already on the roster.");
    setBusy(true);
    let added = 0;
    for (const n of list) {
      if (await addMember(blankMember({ name: n }))) added++;
      else break;
    }
    setBusy(false);
    setNames("");
    toast(added ? `Added ${added} ${added === 1 ? "person" : "people"}` : "Nobody was added");
  };

  /** Claude offers a search, never a full list, so sweep it letter by letter. */
  const sweep = async () => {
    const user = s.user;
    if (!user) return;
    setBusy(true);
    const found = new Map<string, Profile>();
    const letters = "abcdefghijklmnopqrstuvwxyz".split("");
    for (let i = 0; i < letters.length; i++) {
      setStatus(`Sweeping the directory… ${Math.round((i / letters.length) * 100)}%`);
      const h = await user.search(letters[i]!).catch(() => []);
      for (const p of h) if (p?.id && p.name) found.set(p.id, p);
    }
    setBusy(false);
    setStatus("");
    const people = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (!people.length) return toast("No Claude team directory for this account — add people by name.", true);
    if (people.every((p) => roster.has(p.id))) {
      return toast(people.length === 1 ? "The directory only returned you, and you’re already on the roster." : "Everyone the directory returned is already on the roster.");
    }
    openModal({ kind: "import", people });
  };

  return (
    <Modal title="Add people to the team" foot={<>
      <span className="spacer" />
      <button className="btn" type="button" onClick={closeModal}>Done</button>
      {tab === "team"
        ? <button className="btn primary" type="button" disabled={busy || !s.user} onClick={() => void sweep()}>Sweep the whole directory</button>
        : <button className="btn primary" type="button" disabled={busy} onClick={() => void addTyped()}>Add them</button>}
    </>}>
      {s.user && (
        <div className="seg" style={{ marginBottom: 14 }}>
          <button type="button" aria-pressed={tab === "team"} onClick={() => setTab("team")}>From your Claude team</button>
          <button type="button" aria-pressed={tab === "name"} onClick={() => setTab("name")}>By name</button>
        </div>
      )}
      {tab === "team" ? (
        <div>
          <input id="people-search" type="text" placeholder="Search your Claude team by name" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="mlist" style={{ maxHeight: "38vh", overflowY: "auto", margin: "12px -18px 0", borderTop: "1px solid var(--line)" }}>
            {hits.length === 0 ? (
              q ? (
                <div className="pad tiny dim">Nobody in your Claude team matched that.{" "}
                  <button className="btn sm" type="button" onClick={() => { setNames(q.trim()); setTab("name"); }}>Add by name instead</button>
                </div>
              ) : !answered ? (
                <div className="pad">
                  <strong className="small" style={{ display: "block", marginBottom: 4 }}>No Claude team directory here</strong>
                  <span className="tiny dim">This account isn’t in a Claude organization that shares its member list, so there is nobody to import. Everything else works the same — put the group in by name.</span>
                  <div style={{ marginTop: 10 }}><button className="btn sm primary" type="button" onClick={() => setTab("name")}>Add people by name</button></div>
                </div>
              ) : <div className="pad tiny dim">Start typing a name.</div>
            ) : hits.map((p) => (
              <div className="mrow" key={p.id}>
                <AvatarFor p={p} />
                <div className="nm">
                  <div>{p.name || "Someone"}{p.id === s.uid && <span className="dim"> (you)</span>}</div>
                  {p.email && <div className="tiny dim">{p.email}</div>}
                </div>
                {roster.has(p.id) ? <span className="pill">{p.id === s.uid ? "That’s you" : "On the team"}</span>
                  : <button className="btn sm primary" type="button" onClick={() => void addMember(blankMember({ uid: p.id, nameHint: p.name || "", source: "directory" }), `Added ${p.name || "them"}`)}>Add</button>}
              </div>
            ))}
          </div>
          <div className="tiny dim" style={{ marginTop: 10 }}>{status}</div>
        </div>
      ) : (
        <div>
          <p className="muted small" style={{ margin: "0 0 8px" }}>One name per line. Anyone added this way can still tap “That’s me” when they open the tracker, which links their Claude account from then on.</p>
          <textarea id="people-names" placeholder={"Anja Brunner\nPierre Chassot\nTomás Reyes"} style={{ minHeight: 140 }} value={names} onChange={(e) => setNames(e.target.value)} />
        </div>
      )}
      <p className="tiny dim" style={{ margin: "14px 0 0" }}>Claude offers a search over your team, never a full list, so the sweep goes letter by letter and can miss someone. Nothing is added until you confirm it.</p>
    </Modal>
  );
}

export function Import({ people }: { people: Profile[] }) {
  const roster = onRoster();
  const fresh = people.filter((p) => !roster.has(p.id));
  const [picked, setPicked] = useState(() => new Set(fresh.map((p) => p.id)));
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    let added = 0;
    for (const p of fresh) {
      if (!picked.has(p.id)) continue;
      if (await addMember(blankMember({ uid: p.id, nameHint: p.name || "", source: "directory" }))) added++;
    }
    closeModal();
    toast(added ? `Added ${added} ${added === 1 ? "person" : "people"}` : "Nobody was added");
  };
  return (
    <Modal title={`Found ${people.length} in your Claude team`} foot={<>
      <span className="spacer" />
      <button className="btn" type="button" onClick={closeModal}>Cancel</button>
      <button className="btn primary" type="button" disabled={!picked.size || busy} onClick={() => void go()}>
        {picked.size ? `Add ${picked.size} ${picked.size === 1 ? "person" : "people"}` : "Add nobody"}
      </button>
    </>}>
      <p className="muted small" style={{ margin: "0 0 10px" }}>Everyone the directory would show. Untick anyone who isn’t in the team — students and collaborators from other groups will be in here too.</p>
      <div style={{ maxHeight: "46vh", overflowY: "auto", margin: "0 -18px" }}>
        {people.map((p) => {
          const already = roster.has(p.id);
          return (
            <label key={p.id} className="mrow" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={!already && picked.has(p.id)} disabled={already}
                onChange={(e) => { const n = new Set(picked); if (e.target.checked) n.add(p.id); else n.delete(p.id); setPicked(n); }} />
              <AvatarFor p={p} />
              <div className="nm"><div>{p.name}</div>{p.email && <div className="tiny dim">{p.email}</div>}</div>
              {already && <span className="pill">Already on the team</span>}
            </label>
          );
        })}
      </div>
    </Modal>
  );
}
