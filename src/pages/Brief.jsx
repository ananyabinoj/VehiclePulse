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
          <strong>Similar reports</strong> — surfaces reports describing the same underlying problem so
          repeated incidents are not worked as unrelated tickets. A high similarity score is a prompt to
          check, not a confirmed duplicate.
        </li>
        <li>
          <strong>Owner</strong> — turns analysis into an actionable next step.
        </li>
      </ul>
      <p>
        Every one of those fields is published with a one-line reason drawn from the report itself, so a
        reviewer can always answer &ldquo;why did the system decide this?&rdquo; without rerunning anything.
        Where the evidence does not support a conclusion, the field says so — <em>Trigger unclear</em>,{" "}
        <em>Recovery: Unknown</em>, <em>Affected vehicles: Unknown</em> — rather than filling the gap with a
        plausible guess.
      </p>

      <h3>Data</h3>
      <p>
        The demo corpus is <strong>synthetic</strong>, written to resemble real automotive support traffic:
        fleet-wide OTA failures, one-off incidents, enhancement requests filed as bugs, and reports whose
        wording is far more alarming than their actual impact.
      </p>
      <p>
        On top of that, CSV, TSV and the NHTSA tab-delimited complaint flat file can be imported directly.
        Imported records are labelled <strong>NHTSA / Public</strong> throughout the interface and are never
        presented as internal OEM support tickets — they are public consumer complaints, one owner and one
        vehicle each. A single complaint filed against several components arrives as several rows sharing an
        ODINO and is stored as one report, so it is not counted as several independent customers. Nothing is
        stored until the import preview is confirmed, and the dataset itself is parsed locally rather than
        being sent to a model.
      </p>

      <h3>How the analysis runs</h3>
      <p>
        With an <code>OPENAI_API_KEY</code> present in the server environment, reports are triaged by the model
        against the rubric above, with the most similar existing reports supplied as context; the interface
        marks this <em>Live analysis</em>. Without a key the app runs in <em>Demo Mode</em> on pre-generated
        and rule-based analysis, and says so rather than passing rules off as a model. The key is read
        server-side only and is never sent to the browser.
      </p>

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
      <p>
        Reports and vehicles are deliberately kept apart. One report can represent one vehicle; another can
        represent a two-thousand-vehicle fleet. The score uses the vehicle count a report actually states, and
        reports that state none are counted as unknown rather than as one or as zero.
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
        <li>Automatic vehicle control or remote commands</li>
        <li>Automatic production OTA rollout decisions</li>
        <li>Fully autonomous incident escalation</li>
        <li>Real vehicle telemetry and internal OEM ticket systems</li>
        <li>Safety-critical decision making</li>
      </ul>
      <p>The MVP is a decision-support tool, not an autonomous vehicle system.</p>
    </main>
  );
}
