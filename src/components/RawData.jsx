/**
 * §13 — the untouched source row behind an imported report.
 *
 * Normalization is the app's judgement; the original row is the evidence. This renders it
 * exactly as imported so a reviewer can check what the desk started from. Shared by Intake
 * and Theme detail so both show the same thing.
 */
export default function RawData({ raw }) {
  if (!raw) return <p className="note">Loading source row…</p>;
  if (!raw.available) return <p className="note">{raw.note}</p>;
  return (
    <div>
      <p className="note" style={{ marginTop: 0 }}>
        {raw.rowCount} source row{raw.rowCount === 1 ? "" : "s"}
        {raw.groupedBy ? ` grouped by ${raw.groupedBy}` : ""} · exactly as imported, nothing normalized.
      </p>
      {(raw.rows || []).map((row, i) => (
        <table className="table table-tight" key={i} style={{ marginBottom: 8 }}>
          <tbody>
            {Object.entries(row)
              .filter(([, v]) => String(v ?? "").trim() !== "")
              .map(([k, v]) => (
                <tr key={k}>
                  <td className="mono" style={{ width: 190 }}>
                    {k}
                  </td>
                  <td>{String(v)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      ))}
    </div>
  );
}
