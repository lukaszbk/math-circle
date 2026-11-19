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

var TAB_PARTICIPANTS = 'Participants';
var TAB_STUDENTS = 'Students';
var TAB_SUBMISSIONS = 'Submissions';
var TAB_CONFIG = 'Config';

var STUDENTS_HEADERS = ['student_id', 'name', 'pin', 'avatar', 'active'];
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
    }
  }
  return sheet;
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
  for (var j = 0; j < existingStudents.length; j++) {
    existingNames[existingStudents[j].name.trim().toLowerCase()] = true;
    usedIds[existingStudents[j].studentId] = true;
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
    for (var m = 0; m < existingStudents.length; m++) {
      existingNames[existingStudents[m].name.trim().toLowerCase()] = true;
      usedIds[existingStudents[m].studentId] = true;
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
          true
        ]);
      }
    }

    if (toAppend.length > 0) {
      var startRow = Math.max(studentsSheet.getLastRow() + 1, 2);
      studentsSheet.getRange(startRow, 3, toAppend.length, 1).setNumberFormat('@');
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
      active: active
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

function handleGetTeacherReport_(ss, payload) {
  ensureSchemaAndSync_(ss);
  var teacherPin = payload ? payload.teacherPin : '';
  if (!isValidTeacherPin_(ss, teacherPin)) {
    return { ok: false, error: 'Incorrect Teacher PIN.' };
  }

  var activeWeekId = getActiveWeekId_(ss);
  var weekId = (payload && payload.weekId) ? String(payload.weekId).trim() : activeWeekId;
  var students = readStudents_(ss.getSheetByName(TAB_STUDENTS));
  var rawSubs = readSubmissionsForWeek_(ss.getSheetByName(TAB_SUBMISSIONS), weekId);

  var submissions = [];
  for (var i = 0; i < rawSubs.length; i++) {
    var s = rawSubs[i];
    submissions.push({
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
    });
  }

  return {
    ok: true,
    activeWeekId: activeWeekId,
    weekId: weekId,
    sheetUrl: ss.getUrl(),
    sheetName: ss.getName(),
    students: students,
    submissions: submissions
  };
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
    var usedIds = {};
    var rows = [];
    var saved = [];

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
      var avatar = String(st.avatar || AVATAR_POOL[i % AVATAR_POOL.length]).trim() || '🦊';
      var active = st.active !== false;

      rows.push([studentId, name, pin, avatar, active]);
      saved.push({
        studentId: studentId,
        name: name,
        pin: pin,
        avatar: avatar,
        active: active
      });
    }

    var existingLastRow = sheet.getLastRow();
    if (existingLastRow >= 2) {
      sheet.getRange(2, 1, existingLastRow - 1, STUDENTS_HEADERS.length).clearContent();
    }
    if (rows.length > 0) {
      // Force plain text '@' format on PIN column so leading zeros (e.g. "0412") never become 412.
      sheet.getRange(2, 1, rows.length, 1).setNumberFormat('@');
      sheet.getRange(2, 3, rows.length, 1).setNumberFormat('@');
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
