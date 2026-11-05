"use strict";

const ROW_ISSUE_CODES = new Set(["inconsistent", "implausible", "anomaly"]);

function isEmpty(value) {
  return value === null || value === undefined ||
    (typeof value === "string" && value.trim() === "");
}

function validateRows(rows, {
  requiredFields = [],
  uniqueBy = [],
  fieldRules = [],
  rowRules = []
} = {}) {
  if (!Array.isArray(rows)) throw new TypeError("rows harus berupa array.");
  if (!Array.isArray(requiredFields) || !Array.isArray(uniqueBy) ||
      !Array.isArray(fieldRules) || !Array.isArray(rowRules)) {
    throw new TypeError("Konfigurasi validasi harus berupa array.");
  }

  const issues = [];
  const seen = new Map();
  const addIssue = (row, field, code, message) => {
    issues.push({ row: row + 1, field, code, message });
  };

  rows.forEach((record, rowIndex) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new TypeError(`Baris ${rowIndex + 1} harus berupa object.`);
    }

    for (const field of requiredFields) {
      if (isEmpty(record[field])) {
        addIssue(rowIndex, field, "missing", `Nilai ${field} kosong.`);
      }
    }

    if (uniqueBy.length > 0 && uniqueBy.every(field => !isEmpty(record[field]))) {
      const key = JSON.stringify(uniqueBy.map(field => record[field]));
      if (seen.has(key)) {
        addIssue(rowIndex, uniqueBy.join(", "), "duplicate", `Duplikat dengan baris ${seen.get(key)}.`);
      } else {
        seen.set(key, rowIndex + 1);
      }
    }

    for (const rule of fieldRules) {
      if (!rule || typeof rule.field !== "string" || typeof rule.validate !== "function" ||
          typeof rule.message !== "string") {
        throw new TypeError("Setiap field rule harus memiliki field, validate, dan message.");
      }
      const value = record[rule.field];
      if (!isEmpty(value) && !rule.validate(value, record)) {
        addIssue(rowIndex, rule.field, rule.code || "invalid_format", rule.message);
      }
    }

    for (const rule of rowRules) {
      if (!rule || typeof rule.validate !== "function" || typeof rule.message !== "string" ||
          !ROW_ISSUE_CODES.has(rule.code)) {
        throw new TypeError("Setiap row rule harus memiliki validate, message, dan code yang didukung.");
      }
      if (!rule.validate(record, rowIndex)) {
        addIssue(rowIndex, rule.field || "", rule.code, rule.message);
      }
    }
  });

  return { valid: issues.length === 0, issueCount: issues.length, issues };
}

module.exports = { validateRows };
