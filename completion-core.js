/*! SOAP Analytics - shared completion calculations (V76).
 *
 * Single source of truth for contributor completion percentages. Loaded by
 * admin.html and portal.html in the browser (window.SoapCompletion) and
 * imported by the admin-send-completion-reminders Edge Function (CommonJS /
 * ES import). The calculation bodies are the V74/V75 rules moved here
 * UNCHANGED from admin.html; the only addition is an optional trailing `asOf`
 * (a Date) so the server can evaluate "today" explicitly. Omitted, behaviour is
 * identical to V75 (uses new Date()).
 *
 * V74 rules preserved: completion is cumulative; a period counts only once the
 * NEXT reporting period's start_date <= today; future periods are excluded from
 * required and completed totals even if entered early; duplicate stored cells
 * count once.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SoapCompletion = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const CONTEXT_PERIODS = ['AUT1 26', 'AUT2 26', 'SPR1 27', 'SPR2 27', 'SUM1 27', 'SUM2 27'];
  const PERIOD_TO_REPORTING_NAME = {
    'AUT1 26': 'Autumn 1', 'AUT2 26': 'Autumn 2',
    'SPR1 27': 'Spring 1', 'SPR2 27': 'Spring 2',
    'SUM1 27': 'Summer 1', 'SUM2 27': 'Summer 2'
  };
  const ALL_YEAR_GROUPS = ['EYFS','Y1','Y2','Y3','Y4','Y5','Y6','Y7','Y8','Y9','Y10','Y11','Y12','Y13'];
  const PHASE_YEAR_GROUPS = {
    'Primary': ['EYFS','Y1','Y2','Y3','Y4','Y5','Y6'],
    'Infant': ['EYFS','Y1','Y2'],
    'Junior': ['Y3','Y4','Y5','Y6'],
    'Secondary': ['Y7','Y8','Y9','Y10','Y11','Y12','Y13'],
    'Sixth Form College': ['Y12','Y13']
  };

  // V74: Completion follows the previous reporting period, not entry unlocking.
  // SUM2 rollover is deliberately deferred until the future academic-year project.
  function completionDuePeriods(schoolReportingPeriods, asOf = new Date()) {
    const due = new Set();
    const today = `${asOf.getFullYear()}-${String(asOf.getMonth() + 1).padStart(2, '0')}-${String(asOf.getDate()).padStart(2, '0')}`;
    for (let i = 0; i < CONTEXT_PERIODS.length - 1; i++) {
      const nextName = PERIOD_TO_REPORTING_NAME[CONTEXT_PERIODS[i + 1]];
      const next = (schoolReportingPeriods || []).find(r => r.period_name === nextName);
      const start = typeof next?.start_date === 'string' ? next.start_date.slice(0, 10) : '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(start) && start <= today) due.add(CONTEXT_PERIODS[i]);
    }
    return due;
  }

  // Count only saved cells which exist in the denominator; ignore calculated YTD,
  // extra PAL/PAH, future periods and duplicate stored cells.
  function countEligibleCompletionRows(rows, duePeriods, kind, yearGroups = []) {
    const seen = new Set();
    for (const r of (rows || [])) {
      const period = r.period, category = r.category, metric = r.metric;
      let eligible = false;
      if (duePeriods.has(period)) {
        if (kind === 'context') eligible = (category === 'Whole School' && ['Number on Roll','PAN'].includes(metric)) || (category === 'Year Group Profile' && yearGroups.includes(metric)) || (category === 'Pupil Profile' && ['Boys %','FSM %','Pupil Premium %','Mobility %'].includes(metric)) || (category === 'Workforce' && ['Number of Teachers','Number of Support Staff','Number of SLT','Number of ECTs','Number of UPS Teachers'].includes(metric));
        if (kind === 'safeguarding') eligible = category === 'Vulnerability Numbers';
        if (kind === 'inclusion') eligible = category === 'Inclusion Numbers';
        if (kind === 'attendance') eligible = category === 'Attendance Percentages' || category === 'Behaviour Numbers';
      } else if (kind === 'context') eligible = category === 'Year Group Profile' && yearGroups.includes(metric) && period === 'PAN';
      else if (kind === 'safeguarding') eligible = (category === 'Compliance' && ['Status','Date'].includes(period)) || (category === 'Overall Rating' && period === 'Rating');
      else if (kind === 'inclusion') eligible = (category === 'Inclusion Evaluation' && period === 'Rating') || (category === 'Key Dates' && period === 'Date') || (category === 'Overall Rating' && period === 'Rating');
      else if (kind === 'attendance') eligible = category === 'Overall Rating' && period === 'Rating';
      if (eligible) seen.add(JSON.stringify([category,metric,period]));
    }
    return seen.size;
  }

  function contextCompletion(school, schoolReportingPeriods, contextRows, asOf) {
    const yearGroups = PHASE_YEAR_GROUPS[school.phase] || ALL_YEAR_GROUPS;
    const sections = [
      { rows: ['Number on Roll', 'PAN'], hasPan: false },
      { rows: yearGroups, hasPan: true },
      { rows: ['Boys %', 'FSM %', 'Pupil Premium %', 'Mobility %'], hasPan: false },
      { rows: ['Number of Teachers', 'Number of Support Staff', 'Number of SLT', 'Number of ECTs', 'Number of UPS Teachers'], hasPan: false }
    ];
    const duePeriods = completionDuePeriods(schoolReportingPeriods, asOf);
    let total = 0;
    sections.forEach(section => {
      section.rows.forEach(() => {
        CONTEXT_PERIODS.forEach(p => { if (duePeriods.has(p)) total++; });
        if (section.hasPan) total++;
      });
    });
    const filled = countEligibleCompletionRows(contextRows, duePeriods, 'context', yearGroups);
    const pct = total ? Math.round((Math.min(filled, total) / total) * 100) : 0;
    return { pct, filled: Math.min(filled, total), total };
  }

  // Simple completion calculator for flat, non-period-locked tabs — just compares
  // how many rows actually got saved against how many are genuinely expected.
  function rowCountCompletion(rows, totalExpected) {
    const filled = Math.min((rows || []).length, totalExpected);
    const pct = totalExpected ? Math.round((filled / totalExpected) * 100) : 0;
    return { pct, filled, total: totalExpected };
  }

  // School Information isn't stored as rows — it's individual fields on the school itself
  function schoolInfoCompletion(s) {
    // Trust is excluded — many schools genuinely aren't part of a trust, so
    // leaving it blank shouldn't ever cap completion below 100%.
    const fields = [s.urn, s.school_type, s.number_on_roll, s.pan, s.person_responsible];
    const filled = fields.filter(f => f !== null && f !== undefined && f !== '').length;
    const total = fields.length;
    const pct = total ? Math.round((filled / total) * 100) : 0;
    return { pct, filled, total };
  }

  function safeguardingCompletion(schoolReportingPeriods, rows, asOf) {
    const duePeriods = completionDuePeriods(schoolReportingPeriods, asOf);
    let total = 0;
    CONTEXT_PERIODS.forEach(p => { if (duePeriods.has(p)) total += 5; });
    total += 3 * 2;
    total += 1;
    const filled = countEligibleCompletionRows(rows, duePeriods, 'safeguarding');
    const pct = total ? Math.round((Math.min(filled, total) / total) * 100) : 0;
    return { pct, filled: Math.min(filled, total), total };
  }

  function inclusionCompletion(schoolReportingPeriods, rows, asOf) {
    const duePeriods = completionDuePeriods(schoolReportingPeriods, asOf);
    let total = 0;
    CONTEXT_PERIODS.forEach(p => { if (duePeriods.has(p)) total += 5; });
    total += 6; total += 4; total += 1;
    const filled = countEligibleCompletionRows(rows, duePeriods, 'inclusion');
    const pct = total ? Math.round((Math.min(filled, total) / total) * 100) : 0;
    return { pct, filled: Math.min(filled, total), total };
  }

  function curriculumCompletion(curriculumRows) {
    let total = 12; // Intent, Implementation & Assurance: 12 rows
    total += 1; // Overall Rating
    const filled = (curriculumRows || []).length;
    const pct = total ? Math.round((Math.min(filled, total) / total) * 100) : 0;
    return { pct, filled, total };
  }

  function achievementCompletion(assessmentSetupRows, reportingPeriods, rows, asOf) {
    const today = (() => {
      const d = asOf || new Date();
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    })();
    const assessment = (name) => (assessmentSetupRows || []).find(a => a.assessment_name === name);
    const planned = (name) => {
      const row = assessment(name);
      return !!(row && row.planned === 'Yes');
    };
    const live = (name) => {
      const row = assessment(name);
      return !!(row && row.planned === 'Yes' && row.assessment_date && row.assessment_date <= today);
    };
    const gcsePeriods = new Set(['2022/23', '2023/24', '2024/25', '2025/26']);
    const post16Periods = new Set(['2022/23', '2023/24', '2024/25', '2025/26']);
    if (planned('Year 11 PPE 1') && live('Year 11 PPE 1')) gcsePeriods.add('PPE1');
    if (planned('Year 11 PPE 2') && live('Year 11 PPE 2')) gcsePeriods.add('PPE2');
    if (planned('Year 13 PPE 1') && live('Year 13 PPE 1')) post16Periods.add('PPE1');
    if (planned('Year 13 PPE 2') && live('Year 13 PPE 2')) post16Periods.add('PPE2');

    let total = 4; // Foundational Knowledge
    total += 10 * gcsePeriods.size;
    total -= 4; // Progress 8 rows have four historical cells intentionally unavailable
    total += 8 * post16Periods.size;
    total += 1; // Overall Rating

    const filled = (rows || []).filter(r => {
      if (r.category === 'GCSE Outcomes') return gcsePeriods.has(r.period);
      if (r.category === 'Post-16 Outcomes') return post16Periods.has(r.period);
      return true;
    }).length;
    const pct = total ? Math.round((Math.min(filled, total) / total) * 100) : 0;
    return { pct, filled, total };
  }

  function pdwCompletion(pdwRows) {
    let total = 6 * 4; // Stakeholder Voice: 6 rows x 4 columns
    total += 6 * 3; // Year 11 Destinations: 6 rows x 3 years
    total += 7 * 3; // Year 13 Destinations: 7 rows x 3 years (includes Retention Y12 to Y13 %)
    total += 6 * 3; // Enrichment & Clubs: 6 rows x 3 terms
    total += 8; // Gatsby Benchmarks: 8 rows
    total += 1; // Overall Rating
    const filled = (pdwRows || []).length;
    const pct = total ? Math.round((Math.min(filled, total) / total) * 100) : 0;
    return { pct, filled, total };
  }

  function leadershipCompletion(lgRows) {
    let total = 7; // Evaluation: 7 rows
    total += 1; // Overall Rating
    const filled = (lgRows || []).length;
    const pct = total ? Math.round((Math.min(filled, total) / total) * 100) : 0;
    return { pct, filled, total };
  }

  function financeCompletion(financeRows) {
    let total = 5 * 3; // Financial Health: 5 rows x 3 years
    total += 6 * 3; // Recruitment & Retention: 6 rows x 3 years
    total += 3 * 6; // Staff Absence & Cover: 3 rows x 6 periods
    total += 5; // Resource Effectiveness: 5 rows
    total += 1; // Overall Rating
    const filled = (financeRows || []).length;
    const pct = total ? Math.round((Math.min(filled, total) / total) * 100) : 0;
    return { pct, filled, total };
  }

  function attendanceCompletion(schoolReportingPeriods, rows, asOf) {
    const duePeriods = completionDuePeriods(schoolReportingPeriods, asOf);
    let total = 0;
    CONTEXT_PERIODS.forEach(p => { if (duePeriods.has(p)) total += 23; }); // 13 attendance % rows + 10 behaviour rows per period (National Attendance % removed — now sourced centrally, not entered per school)
    total += 1;
    const filled = countEligibleCompletionRows(rows, duePeriods, 'attendance');
    const pct = total ? Math.round((Math.min(filled, total) / total) * 100) : 0;
    return { pct, filled: Math.min(filled, total), total };
  }

  // The nine SOAP data sections, in the order the Contributor Tracker lists them.
  // key = property of the `data` object passed to computeSectionCompletions.
  const SOAP_SECTIONS = [
    { section: 'Context', key: 'context' },
    { section: 'Safeguarding', key: 'safeguarding' },
    { section: 'Inclusion', key: 'inclusion' },
    { section: 'Curriculum & Teaching', key: 'curriculum' },
    { section: 'Achievement', key: 'achievement' },
    { section: 'Attendance & Behaviour', key: 'attendance' },
    { section: 'PDW', key: 'pdw' },
    { section: 'Leadership & Governance', key: 'leadership' },
    { section: 'Finance & Resources', key: 'finance' }
  ];

  // One call for a school: returns [{section, pct, filled, total}] for the nine
  // sections using exactly the functions the Admin tabs use.
  // school: schools row; periods: reporting_periods rows; assess: assessment_setup rows;
  // data: { context, safeguarding, inclusion, curriculum, achievement, attendance, pdw, leadership, finance } row arrays.
  function computeSectionCompletions(school, periods, assess, data, asOf) {
    data = data || {};
    const r = {
      context: contextCompletion(school || {}, periods, data.context, asOf),
      safeguarding: safeguardingCompletion(periods, data.safeguarding, asOf),
      inclusion: inclusionCompletion(periods, data.inclusion, asOf),
      curriculum: curriculumCompletion(data.curriculum),
      achievement: achievementCompletion(assess, periods, data.achievement, asOf),
      attendance: attendanceCompletion(periods, data.attendance, asOf),
      pdw: pdwCompletion(data.pdw),
      leadership: leadershipCompletion(data.leadership),
      finance: financeCompletion(data.finance)
    };
    return SOAP_SECTIONS.map(function (s) {
      var x = r[s.key];
      return { section: s.section, pct: x.pct, filled: x.filled, total: x.total };
    });
  }

  return {
    VERSION: '76.0.0-a',
    CONTEXT_PERIODS: CONTEXT_PERIODS, PERIOD_TO_REPORTING_NAME: PERIOD_TO_REPORTING_NAME,
    ALL_YEAR_GROUPS: ALL_YEAR_GROUPS, PHASE_YEAR_GROUPS: PHASE_YEAR_GROUPS,
    SOAP_SECTIONS: SOAP_SECTIONS,
    completionDuePeriods: completionDuePeriods, countEligibleCompletionRows: countEligibleCompletionRows,
    contextCompletion: contextCompletion, rowCountCompletion: rowCountCompletion, schoolInfoCompletion: schoolInfoCompletion,
    safeguardingCompletion: safeguardingCompletion, inclusionCompletion: inclusionCompletion,
    curriculumCompletion: curriculumCompletion, achievementCompletion: achievementCompletion,
    pdwCompletion: pdwCompletion, leadershipCompletion: leadershipCompletion, financeCompletion: financeCompletion,
    attendanceCompletion: attendanceCompletion, computeSectionCompletions: computeSectionCompletions
  };
});
