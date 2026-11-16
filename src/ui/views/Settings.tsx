import { useState } from "react";
import { DEFAULT_SETTINGS, HOLIDAY_DEFS, holidayDate, PUBLISHED_YEARS, YEAR_END, YEAR_END_FALLBACK, type HolidayDef } from "../../domain/calendar";
import { fmtDate, fmtShort, iso, num, yearOf } from "../../domain/dates";
import { archiveCandidate, archiveYear, DOC_WARN, openModal, saveSettings, toast } from "../../state/actions";
import { useApp } from "../../state/store";
import { YearPicker } from "../common";

const WEEK: [string, number][] = [["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6], ["Sun", 0]];

export function Settings() {
  const [s, d] = useApp();
  const st = s.settings;
  const [teamName, setTeamName] = useState(st.teamName);
  const [days, setDays] = useState(String(st.defaultDays));
  const [thr, setThr] = useState(String(st.approvalThreshold));
  const [hpd, setHpd] = useState(String(d.cal.hoursPerDay()));
  const [workdays, setWorkdays] = useState<number[]>(st.workdays);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!workdays.length) return toast("Pick at least one working day.", true);
    setBusy(true);
    await saveSettings({
      teamName: teamName.trim() || DEFAULT_SETTINGS.teamName,
      defaultDays: Number(days) || 0,
      approvalThreshold: Number(thr) || 0,
      hoursPerDay: Number(hpd) || DEFAULT_SETTINGS.hoursPerDay,
      workdays,
    });
    setBusy(false);
  };

  return (
    <>
      <div className="panel">
        <div className="hd"><h2>How this team works</h2></div>
        <div className="pad">
          <label className="field"><span>Team name</span><input id="set-team" type="text" value={teamName} onChange={(e) => setTeamName(e.target.value)} /></label>
          <div className="row2">
            <label className="field"><span>Default vacation days per year</span><input id="set-days" type="number" min="0" max="90" step="0.5" value={days} onChange={(e) => setDays(e.target.value)} /></label>
            <label className="field"><span>Days bookable without approval</span><input id="set-thr" type="number" min="0" max="30" step="0.5" value={thr} onChange={(e) => setThr(e.target.value)} /></label>
          </div>
          <p className="tiny dim" style={{ margin: "-6px 0 14px" }}>
            Vacation and time off in lieu longer than {num(st.approvalThreshold)} working days in a row go to an approver. Sick leave and remote days are logged directly, and every overtime entry needs approval whatever its size. Changing this never reopens bookings that were already accepted.
          </p>
          <label className="field"><span>Hours in a full working day</span><input id="set-hpd" type="number" min="1" max="14" step="0.1" value={hpd} onChange={(e) => setHpd(e.target.value)} /></label>
          <p className="tiny dim" style={{ margin: "-6px 0 14px" }}>Used to turn banked overtime into days off in lieu. The State of Fribourg contracts 42 h a week at 100 %, which is 8.4 h over five days.</p>
          <label className="field" style={{ marginBottom: 4 }}><span>Working days</span></label>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 2 }}>
            {WEEK.map(([lbl, v]) => (
              <label key={v} className="check" style={{ margin: 0 }}>
                <input type="checkbox" checked={workdays.includes(v)} onChange={(e) => setWorkdays(e.target.checked ? [...workdays, v] : workdays.filter((x) => x !== v))} />
                <span>{lbl}</span>
              </label>
            ))}
          </div>
          <div style={{ marginTop: 16 }}><button className="btn primary" type="button" disabled={busy} onClick={() => void save()}>Save settings</button></div>
        </div>
      </div>
      <Holidays />
      <Storage />
      <About />
    </>
  );
}

function Holidays() {
  const [s, d] = useApp();
  const st = s.settings;
  const y = s.year;
  const ye = d.cal.yearEndFor(y);
  const [cDate, setCDate] = useState(`${y}-12-24`);
  const [cName, setCName] = useState("");
  const [cHalf, setCHalf] = useState(false);

  const row = (def: HolidayDef) => {
    const on = st.holidays.includes(def.key);
    const line = [def.de, `${fmtShort(iso(holidayDate(def, y)))} ${y}`];
    if (def.fraction === 0.5) line.push("afternoon only");
    return (
      <label key={def.key} className="check" style={def.yearly ? { alignItems: "center" } : undefined}>
        <input type="checkbox" checked={on} onChange={(e) => {
          const set = new Set(st.holidays);
          if (e.target.checked) set.add(def.key); else set.delete(def.key);
          void saveSettings({ holidays: [...set] });
        }} />
        <span>{def.name}<span className="tiny dim" style={{ display: "block" }}>{line.join(", ")}</span></span>
        {def.yearly && (
          <select aria-label={`${def.name} ${y}`} style={{ width: "auto", marginLeft: "auto", fontSize: 12.5, padding: "3px 6px" }}
            value={String(Number(ye[def.key as "dec24" | "dec31"] ?? 0))}
            onChange={(e) => {
              const next = { ...st.yearEnd };
              next[String(y)] = { ...(YEAR_END[y] ?? YEAR_END_FALLBACK), ...(next[String(y)] ?? {}), [def.key]: Number(e.target.value) };
              void saveSettings({ yearEnd: next });
            }}>
            <option value="0">not free</option><option value="0.5">afternoon</option><option value="1">full day</option>
          </select>
        )}
      </label>
    );
  };
  const custom = st.customHolidays.map((c, i) => ({ c, i })).filter(({ c }) => yearOf(c.date) === y).sort((a, b) => a.c.date.localeCompare(b.c.date));

  return (
    <div className="panel">
      <div className="hd"><h2>Days off, as the State of Fribourg sets them</h2><span className="spacer" /><YearPicker /></div>
      <div className="pad">
        <h3 className="small" style={{ marginBottom: 8 }}>Gesetzliche Feiertage<span className="tiny dim" style={{ fontWeight: 400 }}> — the nine fixed in cantonal law</span></h3>
        <div className="hol-grid">{HOLIDAY_DEFS.filter((x) => x.kind === "legal").map(row)}</div>
        <h3 className="small" style={{ margin: "20px 0 8px" }}>Dienstfreie Tage<span className="tiny dim" style={{ fontWeight: 400 }}> — granted on top, and reset every year</span></h3>
        <div className="hol-grid">{HOLIDAY_DEFS.filter((x) => x.kind === "service").map(row)}</div>
        <p className="tiny dim" style={{ margin: "16px 0 0" }}>
          {PUBLISHED_YEARS.includes(y)
            ? `Set from the calendar the Amt für Personal und Organisation published for ${y} (fr.ch). In ${y}, ${ye.dec24 === 0.5 ? "24 December is a free afternoon" : ye.dec24 ? "24 December is a full day off" : "24 December is a normal working day"} and ${ye.dec31 ? "31 December is free" : "31 December is a normal working day"}.`
            : `The State hasn’t published ${y} here yet — 24 and 31 December are carried over as a guess. Set them above once fr.ch publishes the year.`}
        </p>
        <p className="tiny dim" style={{ margin: "6px 0 0" }}>If your group follows a different employer’s calendar, switch any of these off.</p>
      </div>
      <div className="hd" style={{ borderTop: "1px solid var(--line)" }}><h2>Days your group adds in {y}</h2></div>
      <div className="mlist">
        {custom.map(({ c, i }) => (
          <div className="mrow" key={i}>
            <span className="num" style={{ width: 110 }}>{fmtDate(c.date)}</span>
            <span className="nm">{c.name}</span>
            <span className="pill">{c.half ? "Half day" : "Full day"}</span>
            <button className="btn sm ghost" type="button" onClick={() => void saveSettings({ customHolidays: st.customHolidays.filter((_, j) => j !== i) })}>Remove</button>
          </div>
        ))}
        <div className="mrow">
          <div style={{ width: 160 }}><input id="closure-date" type="date" value={cDate} onChange={(e) => setCDate(e.target.value)} /></div>
          <div className="nm"><input id="closure-name" type="text" placeholder="Reason, e.g. institute closure" value={cName} onChange={(e) => setCName(e.target.value)} /></div>
          <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={cHalf} onChange={(e) => setCHalf(e.target.checked)} /><span>Half day</span></label>
          <button className="btn sm" type="button" onClick={() => {
            if (!cDate) return;
            void saveSettings({ customHolidays: [...st.customHolidays, { date: cDate, name: cName.trim() || "Office closed", half: cHalf }] });
          }}>Add day off</button>
        </div>
      </div>
    </div>
  );
}

function Storage() {
  const [s, d] = useApp();
  const late = d.model.late.filter((r) => !r.decision && r.entry);
  const docs = [...s.ledgerBytes.entries(), ...[...s.decisionBytes.entries()].map(([k, v]) => [`${k} (decisions)`, v] as [string, number])];
  const biggest = docs.reduce((a, b) => (b[1] > a[1] ? b : a), ["", 0] as [string, number]);
  const pct = Math.min(100, (biggest[1] / (256 * 1024)) * 100);
  const cand = archiveCandidate();
  return (
    <div className="panel">
      <div className="hd"><h2>Storage and archive</h2></div>
      <div className="pad small">
        <p style={{ marginTop: 0 }} className="muted">
          Each person’s bookings live in one record, which can hold about 256 KB. The fullest one is at {Math.round(pct)} %.
          {biggest[1] > DOC_WARN ? " Archive an old year soon to make room." : ""}
        </p>
        <div className="meter"><i className={biggest[1] > DOC_WARN ? "hot" : ""} style={{ width: `${pct}%` }} /></div>
        <p className="muted" style={{ marginBottom: 8 }}>
          Archiving moves a finished year out of the live records. Its leave stays viewable when you pick that year, and banked overtime carries forward.
          {s.settings.archivedBefore != null ? ` Years before ${s.settings.archivedBefore} are archived.` : " Nothing is archived yet."}
        </p>
        {cand.year != null ? (
          <button className="btn" type="button" disabled={cand.blockers.length > 0} title={cand.blockers.join(" ") || undefined}
            onClick={() => openModal({
              kind: "ask", title: `Archive ${cand.year}?`, ok: `Archive ${cand.year}`,
              text: `Everything that ended in ${cand.year} or earlier moves to the archive. It stays readable but can no longer be changed.`,
              onOk: () => archiveYear(cand.year!),
            })}>Archive {cand.year}</button>
        ) : null}
        {cand.blockers.length > 0 && <p className="tiny dim" style={{ marginBottom: 0 }}>{cand.blockers.join(" ")}</p>}
        {late.length > 0 && (
          <p className="tiny dim" style={{ marginBottom: 0 }} data-testid="late-bookings">
            {late.length} {late.length === 1 ? "booking was" : "bookings were"} added to an archived year after it was archived and {late.length === 1 ? "is" : "are"} ignored.
          </p>
        )}
      </div>
    </div>
  );
}

function About() {
  return (
    <div className="panel">
      <div className="hd"><h2>About this tracker</h2></div>
      <div className="pad small muted">
        <p style={{ marginTop: 0 }}>Everyone who can open this artifact sees the whole team’s absences. Balances are worked out live from the bookings, so correcting a booking corrects the balance.</p>
        <p>Sick leave and remote days are recorded but never deducted from vacation. Approved overtime banks up as hours and comes back out as time off in lieu.</p>
        <p>Who can do what is enforced by the artifact itself, not just by this page. Everyone at Contributor can book and cancel their own upcoming time. Only Editors can decide on requests, change the roster or these settings, and record time for someone else. Approvers need Editor access in the share menu.</p>
        <p>Once a booking has been decided, or accepted automatically, an approver’s page keeps a copy, so past leave can’t quietly disappear. A booking made and deleted before any approver opens the tracker leaves no record.</p>
        <p style={{ marginBottom: 0 }}>Days off follow the calendar the Amt für Personal und Organisation publishes for State of Fribourg employees at{" "}
          <a href="https://www.fr.ch/de/arbeit-und-unternehmen/arbeiten-beim-staat/kalender-arbeitszeiten-und-weisen" target="_blank" rel="noopener">fr.ch</a>.
          {" "}Half days such as 1 May and, in some years, 24 December cost half a day of leave, not a whole one.</p>
      </div>
    </div>
  );
}
