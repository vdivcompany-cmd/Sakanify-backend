/**
 * subscription.routes.js
 *
 * Owner-only subscription endpoints. Every route is scoped to
 * req.user.ownerId inside the controller/service — no :ownerId param
 * exists on any of these routes, so there's nothing for a client to
 * spoof (see subscription.controller.js's doc comment).
 */

const express = require('express');
const subscriptionController = require('./subscription.controller');
const { verifyToken, requireRole } = require('../../middleware/auth.middleware');
const { ROLES } = require('../../config/constants.config');

const router = express.Router();

router.use(verifyToken, requireRole(ROLES.OWNER));

router.get('/me', subscriptionController.getMySubscription);
router.post('/expansion-requests', subscriptionController.requestExpansion);

module.exports = router;
