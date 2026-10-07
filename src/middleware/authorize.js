const { roles } = require('../modules/gymAccess/gymAccess.validation');

function createAuthorizationMiddleware(service) {
  return {
    requireGymAccess: async (req, _res, next) => {
      // Overwrite any prior context rather than allowing an earlier scope to survive a denial.
      delete req.authorization;
      try {
        req.authorization = await service.requireGymAccess(req.auth, req.params.gymId);
        return next();
      } catch (error) { return next(error); }
    },
    requireRoles(...allowedRoles) {
      if (!allowedRoles.length || allowedRoles.some((role) => !roles.includes(role))) {
        throw new TypeError('Role authorization requires a nonempty list of supported roles.');
      }
      return (req, _res, next) => {
        try {
          service.requireRoles(req.auth, req.authorization, allowedRoles, req.params?.gymId);
          return next();
        } catch (error) { delete req.authorization; return next(error); }
      };
    },
    requireBranchAccess: async (req, _res, next) => {
      try {
        req.authorization = await service.requireBranchAccess(req.auth, req.authorization,
          req.params.gymId, req.params.branchId);
        return next();
      } catch (error) { delete req.authorization; return next(error); }
    },
  };
}

module.exports = { createAuthorizationMiddleware };
