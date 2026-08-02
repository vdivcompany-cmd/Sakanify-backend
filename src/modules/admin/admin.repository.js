/**
 * admin.repository.js
 *
 * Data-access layer for the admin module's own collection —
 * ImpersonationSession (see impersonation-session.model.js's doc comment
 * for why this collection exists). Controllers/services never touch that
 * mongoose model directly — everything goes through here, per CLAUDE.md
 * Section 7.2.
 *
 * This module deliberately does NOT reach into other modules' collections
 * (User, Building, Bed, Subscription, Audit, Request, Kyc) even though the
 * admin dashboard's data ultimately comes from all of them — see
 * admin.service.js's doc comment: every one of those reads goes through
 * that module's own service function instead, per the same CLAUDE.md
 * Section 7.2 rule this repository itself follows for its own collection.
 */

const ImpersonationSession = require('./impersonation-session.model');

function createSession(data) {
  return ImpersonationSession.create(data);
}

/**
 * The hot-path lookup: is this jti a still-active (not ended) session?
 * Token expiry itself (`exp` claim) is enforced by jwt.verify before this
 * is ever called — this only needs to catch the "session was explicitly
 * ended early" case.
 */
function findActiveByJti(jti) {
  return ImpersonationSession.findOne({ jti, ended_at: null });
}

function findByJti(jti) {
  return ImpersonationSession.findOne({ jti });
}

function endSession(jti, endedByUserId) {
  return ImpersonationSession.findOneAndUpdate(
    { jti, ended_at: null },
    { $set: { ended_at: new Date(), ended_by: endedByUserId } },
    { new: true },
  );
}

module.exports = {
  createSession,
  findActiveByJti,
  findByJti,
  endSession,
};
