/**
 * Math Kangaroo Circle — Bound Google Apps Script Web App Bridge
 *
 * Bound to the teacher's Google Sheet (Extensions -> Apps Script).
 *
 * Deploy as Web App:
 *   Execute as: Me
 *   Who has access: Anyone
 */

var DEFAULT_TEACHER_PIN = '885174';
var DEFAULT_WEEK_ID = '2022-g34-part1';
var LOCK_TIMEOUT_MS = 15000;
var MIN_COHORT_SIZE = 4;
var PARENT_PIN_MAX_FAILS = 10;
var PARENT_PIN_WINDOW_SEC = 60;
var PARENT_PIN_CACHE_KEY = 'mk_parent_pin_fails';

var TAB_PARTICIPANTS = 'Participants';
var TAB_STUDENTS = 'Students';
var TAB_SUBMISSIONS = 'Submissions';
var TAB_CONFIG = 'Config';

var STUDENTS_HEADERS = ['student_id', 'name', 'pin', 'avatar', 'active', 'parent_pin'];
var SUBMISSIONS_HEADERS = [
  'updated_at',
  'week_id',
  'student_id',
  'student_name',
  'total_score',
  'max_score',
  'score_3pt',
  'score_4pt',
  'score_5pt',
  'correct_count',
  'wrong_count',
  'blank_count',
  'answers_summary',
  'answers_json'
];
var CONFIG_HEADERS = ['key', 'value'];

var AVATAR_POOL = ['🦊', '🦁', '🐼', '🦉', '🐸', '🐢', '🦋', '🐙', '🐨', '🐝', '🐧', '🦄'];
var PARTICIPANT_HEADER_WORDS = {
  name: true,
  names: true,
  student: true,
  students: true,
  'student name': true,
  'full name': true,
  participant: true,
  participants: true
};

/**
 * Returns the bound spreadsheet.
 */
function getSpreadsheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('Code.gs must be bound to a Google Sheet (Extensions -> Apps Script).');
  }
  return ss;
}

/**
 * Returns a JSON ContentService response.
 */
function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Normalizes a stored or configured student PIN into a 4-character string
 * (preserving leading zeros such as "0412" even if a sheet cell held 412).
 */
function normalizeStudentPin_(pin) {
  if (pin === null || pin === undefined) {
    return '';
  }
  var s = String(pin).trim();
  if (/^\d{1,4}$/.test(s)) {
    while (s.length < 4) {
      s = '0' + s;
    }
    return s;
  }
  return s;
}

/**
 * Verifies a 4-digit student PIN entered on a keypad without auto-padding
 * short entries (so "412" does not match "0412").
 */
function isPinMatch_(enteredPin, storedPin) {
  if (enteredPin === null || enteredPin === undefined) {
    return false;
  }
  var raw = String(enteredPin).trim();
  var canonical = normalizeStudentPin_(storedPin);
  return /^\d{4}$/.test(raw) && /^\d{4}$/.test(canonical) && raw === canonical;
}

/**
 * Normalizes a 6-digit parent PIN into a 6-character zero-padded string.
 */
function normalizeParentPin_(pin) {
  if (pin === null || pin === undefined || pin === '') {
    return '';
  }
  var s = String(pin).trim();
  if (/^\d{1,6}$/.test(s)) {
    while (s.length < 6) {
      s = '0' + s;
    }
    return s;
  }
  return s;
}

function isParentPinMatch_(enteredPin, storedPin) {
  if (enteredPin === null || enteredPin === undefined) {
    return false;
  }
  var raw = String(enteredPin).trim();
  var canonical = normalizeParentPin_(storedPin);
  return /^\d{6}$/.test(raw) && /^\d{6}$/.test(canonical) && raw === canonical;
}

function isWeakParentPin_(pin) {
  return /^(\d)\1{5}$/.test(pin) || pin === '123456' || pin === '654321';
}

function generateUniqueParentPin_(usedParentPins, teacherPin) {
  var tPin = String(teacherPin || DEFAULT_TEACHER_PIN).trim();
  for (var attempt = 0; attempt < 5000; attempt++) {
    var n = Math.floor(Math.random() * 1000000);
    var s = String(n);
    while (s.length < 6) {
      s = '0' + s;
    }
    if (!isWeakParentPin_(s) && s !== tPin && !usedParentPins[s]) {
      usedParentPins[s] = true;
      return s;
    }
  }
  throw new Error('Could not generate unique 6-digit Parent PIN.');
}

/**
 * Generates a unique lowercase slug student_id from a student name.
 * Transliterates Polish/Latin characters (e.g. "Łucja Nowak" -> "lucja-nowak").
 */
function slugifyName_(name, usedIds) {
  var text = String(name || '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .replace(/ß/g, 'ss')
    .replace(/æ/g, 'ae')
    .replace(/Æ/g, 'AE')
    .replace(/ø/g, 'o')
    .replace(/Ø/g, 'O')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/œ/g, 'oe')
    .replace(/Œ/g, 'OE');
  if (text.normalize) {
    text = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }
  var base = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) {
    base = 'student';
  }
  var candidate = base;
  var suffix = 2;
  while (usedIds[candidate]) {
    candidate = base + '-' + suffix;
    suffix++;
  }
  usedIds[candidate] = true;
  return candidate;
}

/**
 * Simple trigger: adds a Math Circle menu when the spreadsheet opens.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🦘 Math Circle')
    .addItem('Sync Participants to Students', 'syncParticipantsMenuAction')
    .addToUi();
}

/**
 * Menu action to sync Participants!A1:A into Students immediately.
 */
function syncParticipantsMenuAction() {
  var ss = getSpreadsheet_();
  ensureSchemaAndSync_(ss);
  ss.toast('Synced Participants to Students tab.', 'Math Circle');
}

/**
 * Simple trigger: auto-syncs newly typed Participants names into Students.
 */
function onEdit(e) {
  try {
    if (!e || !e.range) {
      return;
    }
    var sheet = e.range.getSheet();
    if (sheet && sheet.getName() === TAB_PARTICIPANTS) {
      ensureSchemaAndSync_(e.source || getSpreadsheet_());
    }
  } catch (err) {
    // Simple triggers should fail silently rather than interrupting sheet edits.
  }
}

/**
 * Generates a random 4-digit PIN string (preserving leading zeros).
 */
function generateRandomPin_() {
  var n = Math.floor(Math.random() * 10000);
  var s = String(n);
  while (s.length < 4) {
    s = '0' + s;
  }
  return s;
}

/**
 * Ensures a sheet tab exists and has the expected header row.
 */
function ensureTabWithHeaders_(ss, tabName, headers) {
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    sheet = ss.insertSheet(tabName);
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    if (tabName === TAB_STUDENTS) {
      sheet.getRange(1, 3, Math.max(sheet.getMaxRows(), 2), 1).setNumberFormat('@');
      sheet.getRange(1, 6, Math.max(sheet.getMaxRows(), 2), 1).setNumberFormat('@');
    }
  }
  return sheet;
}

function getReleasedWeekIds_(ss) {
  var cfg = readConfigMap_(ss);
  var raw = String(cfg.released_week_ids || '').trim();
  if (!raw) {
    return [];
  }
  var parts = raw.split(',');
  var seen = {};
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var w = String(parts[i] || '').trim();
    if (w && !seen[w]) {
      seen[w] = true;
      out.push(w);
    }
  }
  return out;
}

/**
 * Auto-upgrades existing 5-column Students tabs to include F1='parent_pin'
 * and backfills unique 6-digit parent PINs for any row missing a valid one.
 */
function ensureStudentsParentPins_(ss) {
  var sheet = ss.getSheetByName(TAB_STUDENTS);
  if (!sheet || sheet.getLastRow() === 0) {
    return;
  }
  var teacherPin = String(getTeacherPin_(ss)).trim();
  var lastRow = sheet.getLastRow();
  var headerVal = String(sheet.getRange(1, 6, 1, 1).getValue() || '').trim();
  var needsUpgrade = (headerVal !== 'parent_pin');

  if (!needsUpgrade && lastRow >= 2) {
    var existingPins = sheet.getRange(2, 6, lastRow - 1, 1).getValues();
    var seenPins = {};
    for (var i = 0; i < existingPins.length; i++) {
      var p = normalizeParentPin_(existingPins[i][0]);
      if (!/^\d{6}$/.test(p) || p === teacherPin || seenPins[p]) {
        needsUpgrade = true;
        break;
      }
      seenPins[p] = true;
    }
  }
  if (!needsUpgrade) {
    return;
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    return;
  }
  try {
    lastRow = sheet.getLastRow();
    if (String(sheet.getRange(1, 6, 1, 1).getValue() || '').trim() !== 'parent_pin') {
      sheet.getRange(1, 6, 1, 1).setValue('parent_pin');
    }
    sheet.getRange(1, 6, Math.max(sheet.getMaxRows(), 2), 1).setNumberFormat('@');
    if (lastRow < 2) {
      return;
    }
    var rows = sheet.getRange(2, 1, lastRow - 1, STUDENTS_HEADERS.length).getValues();
    var usedParentPins = {};
    var normalized = [];
    for (var j = 0; j < rows.length; j++) {
      var rowId = String(rows[j][0] || '').trim();
      var rowName = String(rows[j][1] || '').trim();
      var pPin = normalizeParentPin_(rows[j][5]);
      if ((rowId || rowName) && /^\d{6}$/.test(pPin) && pPin !== teacherPin && !usedParentPins[pPin]) {
        usedParentPins[pPin] = true;
        normalized.push(pPin);
      } else {
        normalized.push('');
      }
    }
    var changed = false;
    var outCol = [];
    for (var k = 0; k < rows.length; k++) {
      var hasStudent = Boolean(String(rows[k][0] || '').trim() || String(rows[k][1] || '').trim());
      if (!hasStudent) {
        outCol.push([rows[k][5] || '']);
        continue;
      }
      if (!normalized[k]) {
        normalized[k] = generateUniqueParentPin_(usedParentPins, teacherPin);
        changed = true;
      } else if (String(rows[k][5] || '') !== normalized[k]) {
        changed = true;
      }
      outCol.push([normalized[k]]);
    }
    if (changed && outCol.length > 0) {
      sheet.getRange(2, 6, outCol.length, 1).setNumberFormat('@');
      sheet.getRange(2, 6, outCol.length, 1).setValues(outCol);
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Reads all Config key-value pairs into an object.
 */
function readConfigMap_(ss) {
  var sheet = ensureTabWithHeaders_(ss, TAB_CONFIG, CONFIG_HEADERS);
  var map = {};
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return map;
  }
  var rows = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  for (var i = 0; i < rows.length; i++) {
    var k = String(rows[i][0] || '').trim();
    if (k) {
      map[k] = String(rows[i][1] === null || rows[i][1] === undefined ? '' : rows[i][1]).trim();
    }
  }
  return map;
}

function getTeacherPin_(ss) {
  var cfg = readConfigMap_(ss);
  return cfg.teacher_pin || DEFAULT_TEACHER_PIN;
}

function getActiveWeekId_(ss) {
  var cfg = readConfigMap_(ss);
  return cfg.active_week_id || DEFAULT_WEEK_ID;
}

function isValidTeacherPin_(ss, teacherPin) {
  if (teacherPin === null || teacherPin === undefined) {
    return false;
  }
  return String(teacherPin).trim() === String(getTeacherPin_(ss)).trim();
}

/**
 * Appends any student name in Participants!A1:A not yet present in Students
 * (matched case-insensitively by name). Never overwrites existing students or
 * modifies Participants.
 */
function syncParticipantsToStudents_(ss) {
  var studentsSheet = ensureTabWithHeaders_(ss, TAB_STUDENTS, STUDENTS_HEADERS);
  var participantsSheet = ss.getSheetByName(TAB_PARTICIPANTS);
  if (!participantsSheet || participantsSheet.getLastRow() === 0) {
    return;
  }

  var pRows = participantsSheet.getRange(1, 1, participantsSheet.getLastRow(), 1).getValues();
  var candidateNames = [];
  for (var i = 0; i < pRows.length; i++) {
    var rawName = String(pRows[i][0] || '').trim();
    if (!rawName) {
      continue;
    }
    if (i === 0 && PARTICIPANT_HEADER_WORDS[rawName.toLowerCase()]) {
      continue;
    }
    candidateNames.push(rawName);
  }
  if (candidateNames.length === 0) {
    return;
  }

  var existingStudents = readStudents_(studentsSheet);
  var existingNames = {};
  var usedIds = {};
  var usedParentPins = {};
  for (var j = 0; j < existingStudents.length; j++) {
    existingNames[existingStudents[j].name.trim().toLowerCase()] = true;
    usedIds[existingStudents[j].studentId] = true;
    if (/^\d{6}$/.test(existingStudents[j].parentPin)) {
      usedParentPins[existingStudents[j].parentPin] = true;
    }
  }

  var missing = [];
  for (var k = 0; k < candidateNames.length; k++) {
    var nameKey = candidateNames[k].toLowerCase();
    if (!existingNames[nameKey]) {
      existingNames[nameKey] = true;
      missing.push(candidateNames[k]);
    }
  }
  if (missing.length === 0) {
    return;
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    return;
  }
  try {
    // Re-read inside lock to avoid duplicate appends under concurrent requests.
    existingStudents = readStudents_(studentsSheet);
    existingNames = {};
    usedIds = {};
    usedParentPins = {};
    var teacherPin = getTeacherPin_(ss);
    for (var m = 0; m < existingStudents.length; m++) {
      existingNames[existingStudents[m].name.trim().toLowerCase()] = true;
      usedIds[existingStudents[m].studentId] = true;
      if (/^\d{6}$/.test(existingStudents[m].parentPin)) {
        usedParentPins[existingStudents[m].parentPin] = true;
      }
    }

    var toAppend = [];
    for (var n = 0; n < candidateNames.length; n++) {
      var nm = candidateNames[n];
      var key = nm.toLowerCase();
      if (!existingNames[key]) {
        existingNames[key] = true;
        var idx = existingStudents.length + toAppend.length;
        toAppend.push([
          slugifyName_(nm, usedIds),
          nm,
          generateRandomPin_(),
          AVATAR_POOL[idx % AVATAR_POOL.length],
          true,
          generateUniqueParentPin_(usedParentPins, teacherPin)
        ]);
      }
    }

    if (toAppend.length > 0) {
      var startRow = Math.max(studentsSheet.getLastRow() + 1, 2);
      studentsSheet.getRange(startRow, 3, toAppend.length, 1).setNumberFormat('@');
      studentsSheet.getRange(startRow, 6, toAppend.length, 1).setNumberFormat('@');
      studentsSheet.getRange(startRow, 1, toAppend.length, STUDENTS_HEADERS.length).setValues(toAppend);
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Ensures Students, Submissions, and Config tabs exist and syncs Participants.
 */
function ensureSchemaAndSync_(ss) {
  ensureTabWithHeaders_(ss, TAB_STUDENTS, STUDENTS_HEADERS);
  ensureTabWithHeaders_(ss, TAB_SUBMISSIONS, SUBMISSIONS_HEADERS);
  ensureTabWithHeaders_(ss, TAB_CONFIG, CONFIG_HEADERS);
  ensureStudentsParentPins_(ss);
  syncParticipantsToStudents_(ss);
}

function readStudents_(studentsSheet) {
  var lastRow = studentsSheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }
  var values = studentsSheet.getRange(2, 1, lastRow - 1, STUDENTS_HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var studentId = String(row[0] || '').trim();
    var name = String(row[1] || '').trim();
    if (!studentId && !name) {
      continue;
    }
    var activeVal = row[4];
    var active = !(activeVal === false || String(activeVal).trim().toUpperCase() === 'FALSE');
    out.push({
      studentId: studentId,
      name: name,
      pin: normalizeStudentPin_(row[2]),
      avatar: String(row[3] || '🦊').trim() || '🦊',
      active: active,
      parentPin: normalizeParentPin_(row[5])
    });
  }
  return out;
}

function findStudentById_(students, studentId) {
  var target = String(studentId || '').trim();
  for (var i = 0; i < students.length; i++) {
    if (students[i].studentId === target) {
      return students[i];
    }
  }
  return null;
}

function readSubmissionsForWeek_(submissionsSheet, weekId) {
  var lastRow = submissionsSheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }
  var values = submissionsSheet.getRange(2, 1, lastRow - 1, SUBMISSIONS_HEADERS.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var rowWeek = String(row[1] || '').trim();
    if (weekId && rowWeek !== weekId) {
      continue;
    }
    var answersObj = {};
    try {
      answersObj = row[13] ? JSON.parse(String(row[13])) : {};
    } catch (err) {
      answersObj = {};
    }
    out.push({
      rowNumber: i + 2,
      updatedAt: String(row[0] || ''),
      weekId: rowWeek,
      studentId: String(row[2] || '').trim(),
      studentName: String(row[3] || '').trim(),
      totalScore: Number(row[4] || 0),
      maxScore: Number(row[5] || 48),
      score3pt: Number(row[6] || 0),
      score4pt: Number(row[7] || 0),
      score5pt: Number(row[8] || 0),
      correctCount: Number(row[9] || 0),
      wrongCount: Number(row[10] || 0),
      blankCount: Number(row[11] || 0),
      answersSummary: String(row[12] || ''),
      answers: answersObj
    });
  }
  return out;
}

function formatAnswersSummary_(answersObj) {
  var keys = Object.keys(answersObj || {}).sort(function (a, b) {
    return Number(a) - Number(b);
  });
  var parts = [];
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var val = answersObj[k];
    parts.push(k + ':' + (val ? String(val) : '—'));
  }
  return parts.join(', ');
}

function upsertConfigValue_(ss, key, value) {
  var sheet = ensureTabWithHeaders_(ss, TAB_CONFIG, CONFIG_HEADERS);
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var keys = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < keys.length; i++) {
      if (String(keys[i][0] || '').trim() === key) {
        var targetRange = sheet.getRange(i + 2, 2, 1, 1);
        targetRange.setNumberFormat('@');
        targetRange.setValue(String(value));
        return;
      }
    }
  }
  var newRow = Math.max(lastRow + 1, 2);
  sheet.getRange(newRow, 2, 1, 1).setNumberFormat('@');
  sheet.getRange(newRow, 1, 1, 2).setValues([[String(key), String(value)]]);
}

/**
 * Health check GET handler. Never exposes PINs or student submissions.
 */
function doGet() {
  try {
    var ss = getSpreadsheet_();
    ensureSchemaAndSync_(ss);
    var students = readStudents_(ss.getSheetByName(TAB_STUDENTS));
    var activeCount = 0;
    for (var i = 0; i < students.length; i++) {
      if (students[i].active) {
        activeCount++;
      }
    }
    return jsonResponse_({
      ok: true,
      service: 'math-circle-sheet-backend',
      activeWeekId: getActiveWeekId_(ss),
      studentCount: activeCount
    });
  } catch (err) {
    return jsonResponse_({ ok: false, error: err && err.message ? err.message : String(err) });
  }
}

/**
 * JSON POST API router. Accepts text/plain;charset=utf-8 JSON payloads.
 */
function doPost(e) {
  try {
    var rawBody = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    var payload = JSON.parse(rawBody);
    var action = payload && payload.action ? String(payload.action) : '';
    var ss = getSpreadsheet_();

    if (action === 'getPublicRoster') {
      return jsonResponse_(handleGetPublicRoster_(ss, payload));
    }
    if (action === 'verifyStudentPin') {
      return jsonResponse_(handleVerifyStudentPin_(ss, payload));
    }
    if (action === 'submitAnswers') {
      return jsonResponse_(handleSubmitAnswers_(ss, payload));
    }
    if (action === 'getTeacherReport') {
      return jsonResponse_(handleGetTeacherReport_(ss, payload));
    }
    if (action === 'saveStudentRoster') {
      return jsonResponse_(handleSaveStudentRoster_(ss, payload));
    }
    if (action === 'setActiveWeek') {
      return jsonResponse_(handleSetActiveWeek_(ss, payload));
    }
    if (action === 'setWeekReleased') {
      return jsonResponse_(handleSetWeekReleased_(ss, payload));
    }
    if (action === 'getParentReport') {
      return jsonResponse_(handleGetParentReport_(ss, payload));
    }

    return jsonResponse_({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonResponse_({ ok: false, error: err && err.message ? err.message : String(err) });
  }
}

function handleGetPublicRoster_(ss, payload) {
  ensureSchemaAndSync_(ss);
  var activeWeekId = getActiveWeekId_(ss);
  var weekId = (payload && payload.weekId) ? String(payload.weekId).trim() : activeWeekId;

  var students = readStudents_(ss.getSheetByName(TAB_STUDENTS));
  var submissions = readSubmissionsForWeek_(ss.getSheetByName(TAB_SUBMISSIONS), weekId);
  var submittedMap = {};
  for (var i = 0; i < submissions.length; i++) {
    submittedMap[submissions[i].studentId] = true;
  }

  // SECURITY BOUNDARY: Never include pin or answers in public roster.
  var publicStudents = [];
  for (var j = 0; j < students.length; j++) {
    var st = students[j];
    if (!st.active) {
      continue;
    }
    publicStudents.push({
      studentId: st.studentId,
      name: st.name,
      avatar: st.avatar,
      hasSubmitted: Boolean(submittedMap[st.studentId])
    });
  }

  return {
    ok: true,
    activeWeekId: activeWeekId,
    weekId: weekId,
    students: publicStudents
  };
}

function handleVerifyStudentPin_(ss, payload) {
  ensureSchemaAndSync_(ss);
  var activeWeekId = getActiveWeekId_(ss);
  var weekId = (payload && payload.weekId) ? String(payload.weekId).trim() : activeWeekId;
  var studentId = payload && payload.studentId ? String(payload.studentId).trim() : '';
  var pin = payload ? payload.pin : '';

  var students = readStudents_(ss.getSheetByName(TAB_STUDENTS));
  var student = findStudentById_(students, studentId);
  if (!student || !student.active || !isPinMatch_(pin, student.pin)) {
    return {
      ok: true,
      valid: false,
      student: null,
      existingAnswers: null
    };
  }

  var existingAnswers = null;
  var subs = readSubmissionsForWeek_(ss.getSheetByName(TAB_SUBMISSIONS), weekId);
  for (var i = 0; i < subs.length; i++) {
    if (subs[i].studentId === student.studentId) {
      existingAnswers = subs[i].answers;
      break;
    }
  }

  // SECURITY BOUNDARY: Return only raw existingAnswers (no grading/key info).
  return {
    ok: true,
    valid: true,
    student: {
      studentId: student.studentId,
      name: student.name,
      avatar: student.avatar
    },
    existingAnswers: existingAnswers
  };
}

function handleSubmitAnswers_(ss, payload) {
  ensureSchemaAndSync_(ss);
  var activeWeekId = getActiveWeekId_(ss);
  var weekId = (payload && payload.weekId) ? String(payload.weekId).trim() : activeWeekId;
  var studentId = payload && payload.studentId ? String(payload.studentId).trim() : '';
  var pin = payload ? payload.pin : '';
  var answers = (payload && payload.answers && typeof payload.answers === 'object') ? payload.answers : {};
  var summary = (payload && payload.scoreSummary && typeof payload.scoreSummary === 'object') ? payload.scoreSummary : {};

  var students = readStudents_(ss.getSheetByName(TAB_STUDENTS));
  var student = findStudentById_(students, studentId);
  if (!student || !student.active || !isPinMatch_(pin, student.pin)) {
    return { ok: false, error: 'Invalid student or PIN.' };
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    return { ok: false, error: 'Sheet is busy saving classmates\' submissions. Please try again.' };
  }

  try {
    var sheet = ensureTabWithHeaders_(ss, TAB_SUBMISSIONS, SUBMISSIONS_HEADERS);
    var subs = readSubmissionsForWeek_(sheet, weekId);
    var targetRow = null;
    for (var i = 0; i < subs.length; i++) {
      if (subs[i].studentId === student.studentId) {
        targetRow = subs[i].rowNumber;
        break;
      }
    }

    var nowIso = new Date().toISOString();
    var answersJson = JSON.stringify(answers);
    var answersSummary = summary.answersSummary
      ? String(summary.answersSummary)
      : formatAnswersSummary_(answers);

    var rowValues = [[
      nowIso,
      weekId,
      student.studentId,
      student.name,
      Number(summary.totalScore || 0),
      Number(summary.maxScore || 48),
      Number(summary.score3pt || 0),
      Number(summary.score4pt || 0),
      Number(summary.score5pt || 0),
      Number(summary.correctCount || 0),
      Number(summary.wrongCount || 0),
      Number(summary.blankCount || 0),
      answersSummary,
      answersJson
    ]];

    if (targetRow === null) {
      targetRow = Math.max(sheet.getLastRow() + 1, 2);
    }
    sheet.getRange(targetRow, 1, 1, 4).setNumberFormat('@');
    sheet.getRange(targetRow, 13, 1, 2).setNumberFormat('@');
    sheet.getRange(targetRow, 1, 1, SUBMISSIONS_HEADERS.length).setValues(rowValues);

    return {
      ok: true,
      updatedAt: nowIso,
      weekId: weekId,
      studentId: student.studentId
    };
  } finally {
    lock.releaseLock();
  }
}

function getActiveStudentIdSet_(students) {
  var map = {};
  for (var i = 0; i < students.length; i++) {
    if (students[i].active) {
      map[students[i].studentId] = true;
    }
  }
  return map;
}

function serializeSubmission_(s) {
  return {
    updatedAt: s.updatedAt,
    weekId: s.weekId,
    studentId: s.studentId,
    studentName: s.studentName,
    totalScore: s.totalScore,
    maxScore: s.maxScore,
    score3pt: s.score3pt,
    score4pt: s.score4pt,
    score5pt: s.score5pt,
    correctCount: s.correctCount,
    wrongCount: s.wrongCount,
    blankCount: s.blankCount,
    answersSummary: s.answersSummary,
    answers: s.answers
  };
}

function handleGetTeacherReport_(ss, payload) {
  ensureSchemaAndSync_(ss);
  var teacherPin = payload ? payload.teacherPin : '';
  if (!isValidTeacherPin_(ss, teacherPin)) {
    return { ok: false, error: 'Incorrect Teacher PIN.' };
  }

  var activeWeekId = getActiveWeekId_(ss);
  var releasedWeekIds = getReleasedWeekIds_(ss);
  var weekId = (payload && payload.weekId) ? String(payload.weekId).trim() : activeWeekId;
  var includeAllWeeks = Boolean(payload && payload.includeAllWeeks);
  var students = readStudents_(ss.getSheetByName(TAB_STUDENTS));
  var activeIdSet = getActiveStudentIdSet_(students);
  var submissionsSheet = ss.getSheetByName(TAB_SUBMISSIONS);
  var rawSubs = readSubmissionsForWeek_(submissionsSheet, weekId);

  var submissions = [];
  for (var i = 0; i < rawSubs.length; i++) {
    if (activeIdSet[rawSubs[i].studentId]) {
      submissions.push(serializeSubmission_(rawSubs[i]));
    }
  }

  var result = {
    ok: true,
    activeWeekId: activeWeekId,
    weekId: weekId,
    releasedWeekIds: releasedWeekIds,
    sheetUrl: ss.getUrl(),
    sheetName: ss.getName(),
    students: students,
    submissions: submissions
  };

  if (includeAllWeeks) {
    var allRawSubs = readSubmissionsForWeek_(submissionsSheet, '');
    var allSubmissions = [];
    for (var j = 0; j < allRawSubs.length; j++) {
      if (activeIdSet[allRawSubs[j].studentId]) {
        allSubmissions.push(serializeSubmission_(allRawSubs[j]));
      }
    }
    result.allSubmissions = allSubmissions;
  }

  return result;
}

function handleSaveStudentRoster_(ss, payload) {
  ensureSchemaAndSync_(ss);
  var teacherPin = payload ? payload.teacherPin : '';
  if (!isValidTeacherPin_(ss, teacherPin)) {
    return { ok: false, error: 'Incorrect Teacher PIN.' };
  }
  var incoming = (payload && Array.isArray(payload.students)) ? payload.students : [];

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    return { ok: false, error: 'Sheet is busy. Please retry.' };
  }

  try {
    var sheet = ensureTabWithHeaders_(ss, TAB_STUDENTS, STUDENTS_HEADERS);
    var canonicalTeacherPin = String(getTeacherPin_(ss)).trim();
    var usedIds = {};
    var usedParentPins = {};
    var normalizedIncoming = [];

    // First pass: validate student identities, 4-digit PINs, and explicit 6-digit parent PINs.
    for (var i = 0; i < incoming.length; i++) {
      var st = incoming[i] || {};
      var name = String(st.name || '').trim();
      if (!name) {
        continue;
      }
      var rawId = String(st.studentId || '').trim();
      var studentId = (rawId && !usedIds[rawId]) ? rawId : slugifyName_(name, usedIds);
      usedIds[studentId] = true;

      var pin = normalizeStudentPin_(st.pin);
      if (!/^\d{4}$/.test(pin)) {
        return { ok: false, error: 'PIN for ' + name + ' must be exactly 4 digits.' };
      }

      var rawParentPin = (st.parentPin !== undefined && st.parentPin !== null) ? String(st.parentPin).trim() : '';
      var parentPin = '';
      if (rawParentPin !== '') {
        parentPin = normalizeParentPin_(rawParentPin);
        if (!/^\d{6}$/.test(parentPin)) {
          return { ok: false, error: 'Parent PIN for ' + name + ' must be exactly 6 digits.' };
        }
        if (parentPin === canonicalTeacherPin) {
          return { ok: false, error: 'Parent PIN for ' + name + ' cannot match the Teacher PIN.' };
        }
        if (usedParentPins[parentPin]) {
          return { ok: false, error: 'Duplicate Parent PIN for ' + name + '. Each student needs a unique 6-digit Parent PIN.' };
        }
        usedParentPins[parentPin] = true;
      }

      var avatar = String(st.avatar || AVATAR_POOL[normalizedIncoming.length % AVATAR_POOL.length]).trim() || '🦊';
      var active = st.active !== false;
      normalizedIncoming.push({
        studentId: studentId,
        name: name,
        pin: pin,
        avatar: avatar,
        active: active,
        parentPin: parentPin
      });
    }

    var rows = [];
    var saved = [];
    for (var j = 0; j < normalizedIncoming.length; j++) {
      var rec = normalizedIncoming[j];
      var finalParentPin = rec.parentPin || generateUniqueParentPin_(usedParentPins, canonicalTeacherPin);
      rows.push([rec.studentId, rec.name, rec.pin, rec.avatar, rec.active, finalParentPin]);
      saved.push({
        studentId: rec.studentId,
        name: rec.name,
        pin: rec.pin,
        avatar: rec.avatar,
        active: rec.active,
        parentPin: finalParentPin
      });
    }

    var existingLastRow = sheet.getLastRow();
    if (existingLastRow >= 2) {
      sheet.getRange(2, 1, existingLastRow - 1, STUDENTS_HEADERS.length).clearContent();
    }
    if (rows.length > 0) {
      // Force plain text '@' format on PIN columns so leading zeros never drop.
      sheet.getRange(2, 1, rows.length, 1).setNumberFormat('@');
      sheet.getRange(2, 3, rows.length, 1).setNumberFormat('@');
      sheet.getRange(2, 6, rows.length, 1).setNumberFormat('@');
      sheet.getRange(2, 1, rows.length, STUDENTS_HEADERS.length).setValues(rows);
    }

    return {
      ok: true,
      students: saved
    };
  } finally {
    lock.releaseLock();
  }
}

function handleSetActiveWeek_(ss, payload) {
  ensureSchemaAndSync_(ss);
  var teacherPin = payload ? payload.teacherPin : '';
  if (!isValidTeacherPin_(ss, teacherPin)) {
    return { ok: false, error: 'Incorrect Teacher PIN.' };
  }
  var weekId = payload && payload.weekId ? String(payload.weekId).trim() : '';
  if (!weekId) {
    return { ok: false, error: 'weekId is required.' };
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    return { ok: false, error: 'Sheet is busy. Please retry.' };
  }

  try {
    upsertConfigValue_(ss, 'active_week_id', weekId);
    return {
      ok: true,
      activeWeekId: weekId
    };
  } finally {
    lock.releaseLock();
  }
}

function handleSetWeekReleased_(ss, payload) {
  ensureSchemaAndSync_(ss);
  var teacherPin = payload ? payload.teacherPin : '';
  if (!isValidTeacherPin_(ss, teacherPin)) {
    return { ok: false, error: 'Incorrect Teacher PIN.' };
  }
  var weekId = payload && payload.weekId ? String(payload.weekId).trim() : '';
  if (!weekId) {
    return { ok: false, error: 'weekId is required.' };
  }
  var released = Boolean(payload && payload.released);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    return { ok: false, error: 'Sheet is busy. Please retry.' };
  }

  try {
    var current = getReleasedWeekIds_(ss);
    var next = [];
    var seen = {};
    for (var i = 0; i < current.length; i++) {
      if (current[i] !== weekId && !seen[current[i]]) {
        seen[current[i]] = true;
        next.push(current[i]);
      }
    }
    if (released && !seen[weekId]) {
      next.push(weekId);
    }
    upsertConfigValue_(ss, 'released_week_ids', next.join(','));
    return {
      ok: true,
      releasedWeekIds: next
    };
  } finally {
    lock.releaseLock();
  }
}

function computePercentileRounded_(sortedScores, p) {
  if (!sortedScores || sortedScores.length === 0) {
    return null;
  }
  var idx = (sortedScores.length - 1) * p;
  var lo = Math.floor(idx);
  var hi = Math.ceil(idx);
  var frac = idx - lo;
  var val = sortedScores[lo] + (sortedScores[hi] - sortedScores[lo]) * frac;
  return Math.floor(val + 0.5);
}

function computeCohortStatsForWeek_(weekSubs) {
  var n = weekSubs.length;
  if (n < MIN_COHORT_SIZE) {
    return {
      cohortCount: n,
      minCohortMet: false,
      scoreP25: null,
      scoreMedian: null,
      scoreP75: null,
      avgPct3pt: null,
      avgPct4pt: null,
      avgPct5pt: null,
      optionCounts: null
    };
  }

  var scores = [];
  var sum3 = 0;
  var sum4 = 0;
  var sum5 = 0;
  var qKeyMap = {};
  for (var i = 0; i < n; i++) {
    var sub = weekSubs[i];
    scores.push(Number(sub.totalScore || 0));
    sum3 += Number(sub.score3pt || 0);
    sum4 += Number(sub.score4pt || 0);
    sum5 += Number(sub.score5pt || 0);
    var ansKeys = Object.keys(sub.answers || {});
    for (var k = 0; k < ansKeys.length; k++) {
      qKeyMap[String(ansKeys[k])] = true;
    }
  }
  scores.sort(function (a, b) {
    return a - b;
  });

  var optionCounts = {};
  var allQKeys = Object.keys(qKeyMap);
  for (var qi = 0; qi < allQKeys.length; qi++) {
    var qKey = allQKeys[qi];
    var counts = { A: 0, B: 0, C: 0, D: 0, E: 0, blank: 0 };
    for (var si = 0; si < n; si++) {
      var rawChoice = (weekSubs[si].answers || {})[qKey];
      var choice = rawChoice ? String(rawChoice).trim().toUpperCase() : '';
      if (choice === 'A' || choice === 'B' || choice === 'C' || choice === 'D' || choice === 'E') {
        counts[choice] += 1;
      } else {
        counts.blank += 1;
      }
    }
    optionCounts[qKey] = counts;
  }

  return {
    cohortCount: n,
    minCohortMet: true,
    scoreP25: computePercentileRounded_(scores, 0.25),
    scoreMedian: computePercentileRounded_(scores, 0.50),
    scoreP75: computePercentileRounded_(scores, 0.75),
    avgPct3pt: Math.floor((sum3 / (n * 12)) * 100 + 0.5),
    avgPct4pt: Math.floor((sum4 / (n * 16)) * 100 + 0.5),
    avgPct5pt: Math.floor((sum5 / (n * 20)) * 100 + 0.5),
    optionCounts: optionCounts
  };
}

function handleGetParentReport_(ss, payload) {
  var cache = CacheService.getScriptCache();
  var failCount = Number(cache.get(PARENT_PIN_CACHE_KEY) || 0);
  if (failCount >= PARENT_PIN_MAX_FAILS) {
    return {
      ok: false,
      error: 'Too many failed PIN attempts. Please wait a minute and try again.',
      rateLimited: true
    };
  }

  ensureSchemaAndSync_(ss);
  var parentPin = payload ? payload.parentPin : '';
  var students = readStudents_(ss.getSheetByName(TAB_STUDENTS));
  var matched = null;
  for (var i = 0; i < students.length; i++) {
    if (students[i].active && isParentPinMatch_(parentPin, students[i].parentPin)) {
      matched = students[i];
      break;
    }
  }

  if (!matched) {
    cache.put(PARENT_PIN_CACHE_KEY, String(failCount + 1), PARENT_PIN_WINDOW_SEC);
    return {
      ok: true,
      valid: false,
      student: null
    };
  }

  var activeWeekId = getActiveWeekId_(ss);
  var releasedWeekIds = getReleasedWeekIds_(ss);
  var releasedSet = {};
  for (var r = 0; r < releasedWeekIds.length; r++) {
    releasedSet[releasedWeekIds[r]] = true;
  }

  var activeIdSet = getActiveStudentIdSet_(students);
  var allSubs = readSubmissionsForWeek_(ss.getSheetByName(TAB_SUBMISSIONS), '');
  var subsByWeekAll = {};
  var submissionsByWeek = {};
  var unreleasedSubmittedWeekIds = [];
  var unreleasedSeen = {};

  for (var j = 0; j < allSubs.length; j++) {
    var sub = allSubs[j];
    if (!activeIdSet[sub.studentId]) {
      continue;
    }
    if (!subsByWeekAll[sub.weekId]) {
      subsByWeekAll[sub.weekId] = [];
    }
    subsByWeekAll[sub.weekId].push(sub);

    if (sub.studentId === matched.studentId) {
      if (releasedSet[sub.weekId]) {
        submissionsByWeek[sub.weekId] = serializeSubmission_(sub);
      } else if (!unreleasedSeen[sub.weekId]) {
        unreleasedSeen[sub.weekId] = true;
        unreleasedSubmittedWeekIds.push(sub.weekId);
      }
    }
  }

  var cohortByWeek = {};
  for (var w = 0; w < releasedWeekIds.length; w++) {
    var wid = releasedWeekIds[w];
    cohortByWeek[wid] = computeCohortStatsForWeek_(subsByWeekAll[wid] || []);
  }

  return {
    ok: true,
    valid: true,
    activeWeekId: activeWeekId,
    releasedWeekIds: releasedWeekIds,
    student: {
      studentId: matched.studentId,
      name: matched.name,
      avatar: matched.avatar
    },
    submissionsByWeek: submissionsByWeek,
    unreleasedSubmittedWeekIds: unreleasedSubmittedWeekIds,
    cohortByWeek: cohortByWeek
  };
}
