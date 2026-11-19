/* SOAP Analytics — V80 Staff Absence & Cover calculations.
 *
 * Shared by finance-form.html, admin.html (Finance & Resources editor),
 * soap-page.html and exemplar-soap.html so every surface uses one definition.
 *
 * Storage keys are NOT renamed. finance_data keeps
 *   category 'Staff Absence & Cover'
 *   metric   'Teacher Absence %' | 'Cover Lessons / Day' | 'Support Staff Absence %'
 * Only the visible label changes (LABELS below).
 *
 * Rules (V80 request):
 *  - Cover Lessons / Day, per half term = teacher absence days / weekdays in the
 *    period x lessons per day (per-school setting, default 5). Weekdays = Mon-Fri inclusive of start_date and end_date, no
 *    deductions for INSET, bank holidays or closures.
 *  - Blank absence stays blank. An entered 0 gives 0. Missing / invalid / reversed
 *    dates, or a period with zero weekdays, leave the calculation blank.
 *  - YTD teacher / support absence = sum of entered half-term days.
 *  - YTD cover = total teacher days / total weekdays over the SAME matched periods x lessons per day
 *    (not an average of half-term averages). If any period has teacher absence entered
 *    but cannot be matched to valid dates, the YTD cover is left blank and flagged
 *    rather than shown as a partial result.
 *  - Calculated cells (Cover, YTD) are never filled from previously stored figures.
 */
(function (root) {
  'use strict';

  var CATEGORY = 'Staff Absence & Cover';
  var TEACHER = 'Teacher Absence %';
  var COVER = 'Cover Lessons / Day';
  var SUPPORT = 'Support Staff Absence %';
  var ROWS = [TEACHER, COVER, SUPPORT];
  var LABELS = {};
  LABELS[TEACHER] = 'Teacher Absence (number of days)';
  LABELS[COVER] = 'Cover Lessons / Day';
  LABELS[SUPPORT] = 'Support Staff Absence (number of days)';
  var LESSONS_PER_DAY = 5;                     // default where no setting has been saved
  var SETTING_METRIC = 'Lessons per Day';      // finance_data row: category CATEGORY, period 'Setting'
  var SETTING_PERIOD = 'Setting';
  var LESSON_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  function labelFor(metric) { return LABELS[metric] || metric; }

  // ---- dates ---------------------------------------------------------------
  function parseDate(s) {
    if (s === null || s === undefined) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s).trim());
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3];
    var t = Date.UTC(y, mo - 1, d);
    var chk = new Date(t);
    if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) return null;
    return t;
  }

  // -> { weekdays: n } or { weekdays: null, reason: 'missing'|'invalid'|'reversed'|'no weekdays' }
  function weekdayInfo(start, end) {
    var blank = function (v) { return v === null || v === undefined || String(v).trim() === ''; };
    if (blank(start) || blank(end)) return { weekdays: null, reason: 'missing' };
    var a = parseDate(start), b = parseDate(end);
    if (a === null || b === null) return { weekdays: null, reason: 'invalid' };
    if (b < a) return { weekdays: null, reason: 'reversed' };
    var n = 0, DAY = 86400000;
    for (var t = a; t <= b; t += DAY) {
      var dow = new Date(t).getUTCDay();
      if (dow !== 0 && dow !== 6) n++;
    }
    if (n === 0) return { weekdays: null, reason: 'no weekdays' };
    return { weekdays: n };
  }
  function countWeekdays(start, end) { return weekdayInfo(start, end).weekdays; }

  // ---- numbers -------------------------------------------------------------
  // -> { state: 'blank' } | { state: 'valid', value } | { state: 'invalid' }
  function parseDays(raw) {
    if (raw === null || raw === undefined) return { state: 'blank' };
    var s = String(raw).trim();
    if (s === '') return { state: 'blank' };
    if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return { state: 'invalid' };
    var v = Number(s);
    if (!isFinite(v)) return { state: 'invalid' };
    return { state: 'valid', value: v };
  }
  function round(n, dp) { var f = Math.pow(10, dp); return Math.round((n + Number.EPSILON) * f) / f; }
  function fmt(n, dp) { return n === null || n === undefined ? '' : String(round(n, dp)); }

  function datesFromReportingPeriods(rows, periods, nameMap) {
    var out = {};
    periods.forEach(function (p) {
      var match = (rows || []).find(function (r) { return r.period_name === nameMap[p]; });
      out[p] = match ? { start: match.start_date, end: match.end_date } : { start: null, end: null };
    });
    return out;
  }

  // ---- lessons-per-day setting ------------------------------------------------
  // Stored as one finance_data row (no schema change). The default (5) is represented by NO row,
  // so schools that never change it keep exactly the rows they had.
  // -> { state: 'default'|'set'|'invalid'|'error', lessons: number|null }
  function parseLessons(raw) {
    if (raw === null || raw === undefined || String(raw).trim() === '') return { state: 'default', lessons: LESSONS_PER_DAY };
    var s = String(raw).trim();
    if (!/^\d+$/.test(s)) return { state: 'invalid', lessons: null };
    var n = Number(s);
    if (n < 1 || n > 10) return { state: 'invalid', lessons: null };
    return { state: n === LESSONS_PER_DAY ? 'default' : 'set', lessons: n };
  }
  function lessonsFromRows(finRows, loadFailed) {
    if (loadFailed) return { state: 'error', lessons: null };
    var vals = [];
    (finRows || []).forEach(function (r) {
      if (r.category === CATEGORY && r.metric === SETTING_METRIC && r.period === SETTING_PERIOD) vals.push(r.value);
    });
    if (!vals.length) return { state: 'default', lessons: LESSONS_PER_DAY };
    var first = parseLessons(vals[0]);
    for (var i = 1; i < vals.length; i++) { if (String(vals[i]).trim() !== String(vals[0]).trim()) return { state: 'invalid', lessons: null }; }
    return first;
  }
  function lessonsIssue(state) {
    if (state === 'error') return 'The lessons-per-day setting could not be loaded, so cover lessons are not calculated.';
    if (state === 'invalid') return 'The saved lessons-per-day setting is not valid, so cover lessons are not calculated.';
    return null;
  }
  // Selector markup shared by the contributor form and Admin editor. Value '' = default (5): not stored.
  function lessonsSelectHtml(selected, extraAttrs) {
    var sel = parseLessons(selected);
    var cur = sel.state === 'set' ? String(sel.lessons) : '';
    var opts = '<option value=""' + (cur === '' ? ' selected' : '') + '>' + LESSONS_PER_DAY + ' (default)</option>';
    LESSON_OPTIONS.forEach(function (n) {
      if (n === LESSONS_PER_DAY) return;
      opts += '<option value="' + n + '"' + (cur === String(n) ? ' selected' : '') + '>' + n + '</option>';
    });
    return '<span class="lessons-setting" data-category="' + CATEGORY + '" data-metric="' + SETTING_METRIC + '" style="float:right;font-size:12px;font-weight:600;">' +
      '<label>Lessons per day <select data-period="' + SETTING_PERIOD + '" ' + (extraAttrs || '') + ' style="margin-left:4px;">' + opts + '</select></label></span>';
  }

  // ---- core calculation ----------------------------------------------------
  // input: { periods:[..], teacher:{p:raw}, support:{p:raw}, dates:{p:{start,end}}, lessons: number|null (default 5; null = unknown, cover left blank), lessonsIssue }
  // returns numbers (or null) plus human-readable issues.
  function compute(input) {
    var periods = input.periods, issues = [];
    var L = input.lessons === undefined ? LESSONS_PER_DAY : input.lessons;
    var lessonsOk = L !== null && isFinite(L) && L > 0;
    if (!lessonsOk) issues.push(input.lessonsIssue || 'Lessons per day is not valid, so cover lessons are not calculated.');
    var cover = {}, sumT = 0, nT = 0, badT = false, sumS = 0, nS = 0, badS = false;
    var matchedT = 0, matchedW = 0, unmatched = false;
    periods.forEach(function (p) {
      var t = parseDays((input.teacher || {})[p]);
      var s = parseDays((input.support || {})[p]);
      var d = (input.dates || {})[p] || {};
      var wi = weekdayInfo(d.start, d.end);
      cover[p] = null;
      if (t.state === 'invalid') { badT = true; issues.push(p + ': teacher absence is not a valid number of days'); }
      if (t.state === 'valid') {
        sumT += t.value; nT++;
        if (wi.weekdays) {
          if (lessonsOk) cover[p] = round(t.value / wi.weekdays * L, 1);
          matchedT += t.value; matchedW += wi.weekdays;
        } else {
          unmatched = true;
          issues.push(p + ': cover not calculated - reporting period dates ' + (wi.reason === 'missing' ? 'are missing' : wi.reason === 'reversed' ? 'are reversed (end before start)' : wi.reason === 'no weekdays' ? 'contain no weekdays' : 'are invalid'));
        }
      } else if (t.state === 'invalid') { unmatched = true; }
      if (s.state === 'invalid') { badS = true; issues.push(p + ': support staff absence is not a valid number of days'); }
      if (s.state === 'valid') { sumS += s.value; nS++; }
    });
    var coverYTD = null;
    if (matchedW > 0 && !unmatched && lessonsOk) coverYTD = round(matchedT / matchedW * L, 1);
    else if (unmatched) issues.push('YTD cover not calculated - at least one period with teacher absence entered has no valid dates, so a total would be partial');
    return {
      cover: cover,
      coverYTD: coverYTD,
      teacherYTD: (nT && !badT) ? round(sumT, 2) : null,
      supportYTD: (nS && !badS) ? round(sumS, 2) : null,
      issues: issues
    };
  }

  // ---- read-only view model (SOAP pages) ------------------------------------
  // Cover and YTD cells are always calculated; a blank result stays blank (stored
  // Cover/YTD figures are never shown). Teacher/Support half-term cells are the entered values.
  function viewModel(finRows, periods, dates, opts) {
    var ls = lessonsFromRows(finRows, opts && opts.loadFailed);
    var stored = {};
    ROWS.forEach(function (r) { stored[r] = {}; });
    (finRows || []).forEach(function (r) {
      if (r.category === CATEGORY && stored[r.metric]) stored[r.metric][r.period] = r.value;
    });
    var c = compute({ periods: periods, teacher: stored[TEACHER], support: stored[SUPPORT], dates: dates, lessons: ls.lessons, lessonsIssue: lessonsIssue(ls.state) });
    function get(metric, period) {
      if (metric === COVER) return fmt(period === 'YTD' ? c.coverYTD : c.cover[period], 1);
      if (period === 'YTD') return fmt(metric === TEACHER ? c.teacherYTD : c.supportYTD, 2);
      var v = stored[metric][period];
      return v === null || v === undefined ? '' : String(v).trim();
    }
    return { get: get, issues: c.issues, calc: c, lessons: ls };
  }

  // ---- DOM helper for the two editable surfaces ---------------------------
  // scope: element containing rows tr[data-category="Staff Absence & Cover"]
  // opts: { periods, dates, datesError, settingError, issuesEl }
  function readPeriodInputs(scope, metric, periods) {
    var tr = scope.querySelector('tr[data-category="' + CATEGORY + '"][data-metric="' + metric + '"]');
    var out = {};
    periods.forEach(function (p) {
      var el = tr && tr.querySelector('input[data-period="' + p + '"]');
      out[p] = el ? el.value : '';
    });
    return out;
  }
  function setCell(scope, metric, period, value) {
    var tr = scope.querySelector('tr[data-category="' + CATEGORY + '"][data-metric="' + metric + '"]');
    var el = tr && tr.querySelector('input[data-period="' + period + '"]');
    if (el) el.value = value;
  }

  // Writes calculated Cover and YTD cells (blank when not calculable) and lists any issues.
  function refresh(scope, opts) {
    var periods = opts.periods;
    var selEl = scope.querySelector('[data-category="' + CATEGORY + '"][data-metric="' + SETTING_METRIC + '"] select');
    var ls = opts.settingError ? { state: 'error', lessons: null } : parseLessons(selEl ? selEl.value : '');
    var c = compute({
      periods: periods,
      teacher: readPeriodInputs(scope, TEACHER, periods),
      support: readPeriodInputs(scope, SUPPORT, periods),
      dates: opts.dates,
      lessons: ls.lessons, lessonsIssue: lessonsIssue(ls.state)
    });
    periods.forEach(function (p) { setCell(scope, COVER, p, fmt(c.cover[p], 1)); });
    setCell(scope, COVER, 'YTD', fmt(c.coverYTD, 1));
    setCell(scope, TEACHER, 'YTD', fmt(c.teacherYTD, 2));
    setCell(scope, SUPPORT, 'YTD', fmt(c.supportYTD, 2));
    var notes = c.issues.slice();
    if (opts.datesError) notes.unshift('Reporting period dates could not be loaded, so cover lessons cannot be calculated.');
    if (opts.issuesEl) {
      opts.issuesEl.textContent = '';
      opts.issuesEl.style.display = notes.length ? '' : 'none';
      notes.forEach(function (n) {
        var li = opts.issuesEl.ownerDocument.createElement('div');
        li.textContent = '\u26A0 ' + n;
        opts.issuesEl.appendChild(li);
      });
    }
    return c;
  }

  var api = {
    CATEGORY: CATEGORY, TEACHER: TEACHER, COVER: COVER, SUPPORT: SUPPORT, ROWS: ROWS, LABELS: LABELS,
    LESSONS_PER_DAY: LESSONS_PER_DAY, SETTING_METRIC: SETTING_METRIC, SETTING_PERIOD: SETTING_PERIOD, LESSON_OPTIONS: LESSON_OPTIONS,
    parseLessons: parseLessons, lessonsFromRows: lessonsFromRows, lessonsSelectHtml: lessonsSelectHtml,
    labelFor: labelFor, countWeekdays: countWeekdays, weekdayInfo: weekdayInfo, parseDays: parseDays,
    datesFromReportingPeriods: datesFromReportingPeriods, compute: compute,
    viewModel: viewModel, refresh: refresh, fmt: fmt
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AbsenceCover = api;
})(typeof window !== 'undefined' ? window : globalThis);
