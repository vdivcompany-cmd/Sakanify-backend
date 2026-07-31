/**
 * auth.repository.js
 *
 * Data access layer for User model. Provides CRUD operations and
 * handles database-level constraints (unique indexes on email/phone).
 */

const User = require('./auth.model');

/**
 * Create a new user
 */
async function createUser(userData) {
  try {
    const user = await User.create(userData);
    return user;
  } catch (error) {
    // Handle unique constraint violations
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      throw new Error(`User with this ${field} already exists`);
    }
    throw error;
  }
}

/**
 * Find user by ID
 */
async function findUserById(userId, includePassword = false) {
  const query = User.findById(userId);
  if (includePassword) {
    query.select('+password_hash');
  }
  return query.exec();
}

/**
 * Find user by email
 */
async function findUserByEmail(email, includePassword = false) {
  const query = User.findOne({ email: email.toLowerCase().trim() });
  if (includePassword) {
    query.select('+password_hash');
  }
  return query.exec();
}

/**
 * Find user by phone
 */
async function findUserByPhone(phone, includePassword = false) {
  const query = User.findOne({ phone });
  if (includePassword) {
    query.select('+password_hash');
  }
  return query.exec();
}

/**
 * Find user by owner_id
 */
async function findUserByOwnerId(ownerId) {
  return User.findOne({ owner_id: ownerId }).exec();
}

/**
 * Find all users by role
 */
async function findUsersByRole(role, options = {}) {
  const { skip = 0, limit = 50, status = 'active' } = options;
  return User.find({ role, status })
    .skip(skip)
    .limit(limit)
    .exec();
}

/**
 * Update user
 */
async function updateUser(userId, updateData) {
  try {
    const user = await User.findByIdAndUpdate(
      userId,
      { ...updateData, updated_at: new Date() },
      { new: true, runValidators: true },
    );
    return user;
  } catch (error) {
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      throw new Error(`User with this ${field} already exists`);
    }
    throw error;
  }
}

/**
 * Delete user (soft delete by setting status)
 */
async function deleteUser(userId) {
  return User.findByIdAndUpdate(
    userId,
    { status: 'deleted', updated_at: new Date() },
    { new: true },
  );
}

/**
 * Check if email exists
 */
async function emailExists(email) {
  const count = await User.countDocuments({ email: email.toLowerCase().trim() });
  return count > 0;
}

/**
 * Check if phone exists
 */
async function phoneExists(phone) {
  const count = await User.countDocuments({ phone });
  return count > 0;
}

/**
 * Find user by email or phone (for login)
 */
async function findUserByEmailOrPhone(emailOrPhone, role = null, includePassword = false) {
  const query = User.findOne({
    $or: [
      { email: emailOrPhone.toLowerCase().trim() },
      { phone: emailOrPhone },
    ],
  });

  if (role) {
    query.where('role').equals(role);
  }

  if (includePassword) {
    query.select('+password_hash');
  }

  return query.exec();
}

/**
 * Get user count by role
 */
async function countUsersByRole(role) {
  return User.countDocuments({ role, status: 'active' });
}

module.exports = {
  createUser,
  findUserById,
  findUserByEmail,
  findUserByPhone,
  findUserByOwnerId,
  findUsersByRole,
  updateUser,
  deleteUser,
  emailExists,
  phoneExists,
  findUserByEmailOrPhone,
  countUsersByRole,
};