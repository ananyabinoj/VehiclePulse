export default function Brief() {
  return (
    <main className="page brief">
      <h2>VehiclePulse — Turning Vehicle Software Feedback Into Action</h2>
      <p className="lede">One-page product brief for the MVP.</p>

      <h3>Problem</h3>
      <p>
        OEM support teams receive large amounts of messy, inconsistent vehicle software feedback. Important
        recurring problems can be difficult to identify because individual reports rarely contain enough context
        to see the larger pattern.
      </p>

      <h3>What the tool does</h3>
      <p>
        VehiclePulse converts raw support reports into explainable triage decisions and clusters reports into
        recurring themes. It connects individual field incidents to broader product improvement opportunities.
      </p>
      <p>
        The product communicates: <em>here is what the evidence suggests, and here is why</em> — not that the
        model knows what happened. Classifications are AI-assisted and must be reviewed before escalation.
      </p>

      <h3>Triage rubric</h3>
      <ul>
        <li>
          <strong>Subsystem</strong> — tells us which team is likely responsible.
        </li>
        <li>
          <strong>Severity</strong> — prioritizes customer, safety, and operational impact (P0–P3).
        </li>
        <li>
          <strong>Recovery path</strong> — tells us whether the issue can be handled remotely or requires
          physical intervention.
        </li>
        <li>
          <strong>Trigger</strong> — helps engineering reproduce the issue.
        </li>
        <li>
          <strong>Duplicates</strong> — prevents repeated reports from being treated as unrelated incidents.
        </li>
        <li>
          <strong>Owner</strong> — turns analysis into an actionable next step.
        </li>
      </ul>

      <h3>Theme prioritization</h3>
      <p>
        <strong>Priority = affected vehicles × severity weight</strong> (P0=10, P1=5, P2=2, P3=1). This is the
        MVP&apos;s prioritization heuristic, not an industry-standard formula.
      </p>
      <p>
        A problem affecting many vehicles deserves attention even when each individual report looks minor, while
        a severe but isolated issue should remain visible without automatically dominating the entire product
        backlog.
      </p>

      <h3>What I would build next</h3>
      <ul>
        <li>Integration with real OEM support channels</li>
        <li>Real vehicle telemetry correlation</li>
        <li>Automated regression detection</li>
        <li>Better fleet impact estimation</li>
        <li>Engineer feedback loops to improve classifications</li>
        <li>Jira / incident-management integration</li>
        <li>Historical trend analysis</li>
      </ul>

      <h3>What is deliberately left out</h3>
      <ul>
        <li>Automatic vehicle control</li>
        <li>Automatic production rollout decisions</li>
        <li>Fully autonomous incident escalation</li>
        <li>Real vehicle data</li>
        <li>Safety-critical decision making</li>
      </ul>
      <p>The MVP is a decision-support tool, not an autonomous vehicle system.</p>
    </main>
  );
}
