import { Component, useEffect, useRef, type ReactNode } from "react";
import { AccessBanner } from "./common";
import { reviewQueue } from "./views/Team";
import { closeModal, loadArchivedYear, restoreProfile, sealPass, setTab } from "../state/actions";
import { nameOf, store, TABS, useApp } from "../state/store";
import { Calendar } from "./views/Calendar";
import { Timeline } from "./views/Timeline";
import { Requests } from "./views/Requests";
import { Balances } from "./views/Balances";
import { Team } from "./views/Team";
import { Settings } from "./views/Settings";
import { Setup } from "./views/Setup";
import { Identity } from "./views/Identity";
import { ModalHost } from "./dialogs/ModalHost";

export function App() {
  const [s, d] = useApp();
  useProfiles();
  useSealing();
  useEffect(() => { void restoreProfile(); }, [s.uid]);
  useEffect(() => { void loadArchivedYear(s.year); }, [s.year, s.settings.archivedBefore, s.db]);
  useEffect(() => {
    document.title = `${s.settings.teamName || "SMP Physics Team"} — Leave`;
  }, [s.settings.teamName]);
  useEffect(() => {
    if (!s.modal) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeModal(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [s.modal]);

  let body: React.ReactNode;
  let showTabs = false;
  if (s.fatal) {
    body = (
      <div className="gate">
        <h2>Can’t load the team</h2>
        <p>{s.fatal}</p>
      </div>
    );
  } else if (!d.ready || (!s.members.length && !s.definitive.members)) {
    body = <div className="empty">Loading the team’s leave data…</div>;
  } else if (!s.members.length) {
    body = <Setup />;
  } else if (!d.memberId) {
    body = <Identity />;
  } else {
    showTabs = true;
    body = (
      <ViewBoundary key={s.tab}>
        <AccessBanner />
        {s.tab === "timeline" ? <Timeline /> : s.tab === "calendar" ? <Calendar /> : s.tab === "requests" ? <Requests />
          : s.tab === "balances" ? <Balances /> : s.tab === "team" ? <Team /> : s.isAdmin && !d.readOnly ? <Settings /> : <Timeline />}
      </ViewBoundary>
    );
  }

  const pendingForMe = d.isApprover ? d.model.records.filter((r) => r.status === "pending" || r.flags.includes("withdrawal-unconfirmed")).length : 0;
  const teamBadge = d.isApprover ? reviewQueue(s, d).total : 0;

  return (
    <>
      <header className="top">
        <div className="top-in">
          <div className="brand">
            <h1 id="teamName">{s.settings.teamName || "SMP Physics Team"}</h1>
            <span className="sub" id="subtitle">Leave and absence</span>
            <span className="spacer" />
            <span className="sub num" id="whoami">
              {showTabs ? nameOf(s, d, d.memberId) + (d.isApprover ? " · approver" : "") + (d.readOnly ? " · read-only" : "") : ""}
            </span>
          </div>
          <nav className="tabs" id="tabs" aria-label="Sections">
            {showTabs && TABS.filter((t) => t.id !== "settings" || (s.isAdmin && !d.readOnly)).map((t) => (
              <button key={t.id} type="button" aria-current={t.id === s.tab ? "true" : undefined} onClick={() => setTab(t.id)}>
                {t.label}
                {t.id === "requests" && pendingForMe > 0 && <span className="badge" style={{ marginLeft: 6 }}>{pendingForMe}</span>}
                {t.id === "team" && teamBadge > 0 && <span className="badge" style={{ marginLeft: 6 }}>{teamBadge}</span>}
              </button>
            ))}
          </nav>
        </div>
      </header>
      <main id="view">{body}</main>
      <div id="toasts" aria-live="polite">
        {s.toasts.map((t) => <div key={t.id} className={"toast" + (t.bad ? " bad" : "")}>{t.msg}</div>)}
      </div>
      <ModalHost />
    </>
  );
}

/* A render error in one view must not take the whole page down. */
class ViewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(e: unknown) { console.error(e); }
  override render() {
    if (this.state.failed) return <div className="empty"><strong>That view didn’t render</strong>Switch tabs and come back.</div>;
    return this.props.children;
  }
}

/** Resolve names and avatars for every account the data refers to; re-run only when that set changes. */
function useProfiles() {
  const [s, d] = useApp();
  const ids = new Set<string>();
  for (const m of s.members) if (m.uid) ids.add(m.uid);
  for (const uid of d.model.bindings.memberOf.keys()) ids.add(uid);
  for (const l of s.links) ids.add(l.uid);
  for (const j of s.joiners) ids.add(j.uid);
  if (s.uid) ids.add(s.uid);
  const key = [...ids].sort().join(",");
  useEffect(() => {
    const user = store.get().user;
    if (!user || !key) return;
    let live = true;
    user.profiles(key.split(",")).then((ps) => {
      if (!live) return;
      const prev = store.get().profiles;
      const changed = Object.keys(ps).some((id) => prev[id]?.name !== ps[id]?.name || prev[id]?.avatarUrl !== ps[id]?.avatarUrl);
      if (changed) store.set({ profiles: { ...prev, ...ps } });
    }).catch(() => {});
    return () => { live = false; };
  }, [key]);
}

/** In an Editor's page, record self-booked statuses so they can't be erased later (debounced, only on definitive data). */
function useSealing() {
  const [s, d] = useApp();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const allDefinitive = ["settings", "members", "links", "ledger", "decisions"].every((k) => s.definitive[k]);
  useEffect(() => {
    if (!d.isApprover || !d.ready || !allDefinitive) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void sealPass(); }, 1200);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [d.model, d.isApprover, d.ready, allDefinitive]);
  // retry failed seals even when nothing changes
  useEffect(() => {
    if (!d.isApprover) return;
    const t = setInterval(() => { void sealPass(); }, 30_000);
    return () => clearInterval(t);
  }, [d.isApprover]);
}
