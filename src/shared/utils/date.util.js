/**
 * date.util.js
 *
 * Small collection of date helpers shared across modules (request expiry,
 * subscription rollover, payment windows, audit timestamps, etc).
 * Deliberately dependency-free — no moment/dayjs/date-fns — since Phase 0
 * only needs basic arithmetic and formatting.
 */

function now() {
  return new Date();
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function addHours(date, hours) {
  return addMinutes(date, hours * 60);
}

function addDays(date, days) {
  return addHours(date, days * 24);
}

function isPast(date) {
  return date.getTime() < Date.now();
}

function isFuture(date) {
  return date.getTime() > Date.now();
}

function diffInMinutes(dateA, dateB) {
  return Math.round((dateA.getTime() - dateB.getTime()) / (60 * 1000));
}

function diffInDays(dateA, dateB) {
  return Math.round((dateA.getTime() - dateB.getTime()) / (24 * 60 * 60 * 1000));
}

// yyyy-mm-dd, used for logs/reports where a full ISO timestamp is noisy
function formatDate(date) {
  return date.toISOString().split('T')[0];
}

module.exports = {
  now,
  addMinutes,
  addHours,
  addDays,
  isPast,
  isFuture,
  diffInMinutes,
  diffInDays,
  formatDate,
};
