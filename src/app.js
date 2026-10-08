const { createMembershipManagementService } = require('./modules/memberMembershipManagement/management.service');
const { createMembershipManagementRouter } = require('./modules/memberMembershipManagement/management.routes');
const { createMemberMembershipService } = require('./modules/memberMembership/membership.service');
const { createMemberMembershipRouter } = require('./modules/memberMembership/membership.routes');
const { createStaffService } = require('./modules/staff/staff.service');
const { createStaffRouter } = require('./modules/staff/staff.routes');
const { createDashboardService } = require('./modules/gymDashboard/dashboard.service');
const { createDashboardRouter } = require('./modules/gymDashboard/dashboard.routes');
const { createMemberSummaryService } = require('./modules/memberSummary/summary.service');
const { createMemberSummaryRouter } = require('./modules/memberSummary/summary.routes');
const { getAttendanceModel } = require('./modules/attendance/attendance.model');
const { createAttendanceService } = require('./modules/attendance/attendance.service');
const { createAttendanceRouter } = require('./modules/attendance/attendance.routes');
const express = require('express');
const { getPaymentModel } = require('./modules/payments/payment.model');
const { createPaymentService } = require('./modules/payments/payment.service');
const { createPaymentRouter } = require('./modules/payments/payment.routes');
const { getMemberSubscriptionModel } = require('./modules/subscriptions/subscription.model');
const { createSubscriptionService } = require('./modules/subscriptions/subscription.service');
const { createSubscriptionRouter } = require('./modules/subscriptions/subscription.routes');
const { getMembershipPlanModel } = require('./modules/membershipPlans/plan.model');
const { createPlanService } = require('./modules/membershipPlans/plan.service');
const { createPlanRouter } = require('./modules/membershipPlans/plan.routes');
const { getTrainerMemberAssignmentModel } = require('./modules/trainerAssignments/assignment.model');
const { createAssignmentService } = require('./modules/trainerAssignments/assignment.service');
const { createAssignmentRouter } = require('./modules/trainerAssignments/assignment.routes');
const { getTrainerProfileModel } = require('./modules/trainers/trainer.model');
const { createTrainerService } = require('./modules/trainers/trainer.service');
const { createTrainerRouter } = require('./modules/trainers/trainer.routes');
const { getMemberProfileModel } = require('./modules/members/member.model');
const { createMemberService } = require('./modules/members/member.service');
const { createMemberRouter, createMemberOnboardingRouter } = require('./modules/members/member.routes');
const { createAuthorizationService } = require('./modules/authorization/authorization.service');
const { createAuthorizationMiddleware } = require('./middleware/authorize');
const cookieParser = require('cookie-parser');
const { getAuthSessionModel } = require('./modules/auth/authSession.model');
const { getRefreshTokenModel } = require('./modules/auth/refreshToken.model');
const { createAuthService } = require('./modules/auth/auth.service');
const { createAuthRouter } = require('./modules/auth/auth.routes');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');
const { rateLimit } = require('express-rate-limit');
const { createLogger } = require('./config/logger');
const requestId = require('./middleware/requestId');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');
const { getGymModel } = require('./modules/gyms/gym.model');
const { getBranchModel } = require('./modules/branches/branch.model');
const { createGymService } = require('./modules/gyms/gym.service');
const { createBranchService } = require('./modules/branches/branch.service');
const { createGymRouter } = require('./modules/gyms/gym.routes');
const bootstrapOnly = require('./middleware/bootstrapOnly');
const { getUserAccountModel } = require('./modules/userAccounts/userAccount.model');
const { createUserAccountService } = require('./modules/userAccounts/userAccount.service');
const { createUserAccountRouter } = require('./modules/userAccounts/userAccount.routes');
const { getGymAccessModel } = require('./modules/gymAccess/gymAccess.model');
const { createGymAccessService } = require('./modules/gymAccess/gymAccess.service');
const { createGymAccessRouter } = require('./modules/gymAccess/gymAccess.routes');

function buildApp({ config, logger = createLogger(config), database, bootstrap = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // No proxy is trusted until the deployment topology is explicitly configured.
  app.set('trust proxy', false);
  app.locals.config = config;
  app.locals.logger = logger;
  app.locals.ready = true;

  app.use(requestId);
  app.use(pinoHttp({
    logger,
    genReqId: (req) => req.id,
    customProps: (req) => ({ requestId: req.id }),
    serializers: {
      // Deliberately omit headers, query strings, bodies, and client addresses.
      req: (req) => ({ id: req.id, method: req.method }),
      res: (res) => ({ statusCode: res.statusCode }),
      err: (error) => ({ type: error.name, code: error.code, status: error.status }),
    },
  }));
  app.use(helmet());
  app.use(cors({
    origin(origin, callback) {
      if (!origin) return callback(null, false);
      if (config.allowedOrigins.includes(origin)) return callback(null, true);
      const error = new Error('Origin is not allowed.');
      error.code = 'CORS_ORIGIN_DENIED';
      return callback(error);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    exposedHeaders: ['X-Request-ID'],
    maxAge: 600,
  }));
  app.use(rateLimit({
    windowMs: 60 * 1000,
    limit: 100,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // Operational probes do not share the API client quota.
    skip: (req) => ['GET', 'HEAD'].includes(req.method)
      && ['/health', '/ready'].includes(req.path),
    handler(_req, _res, next) {
      const error = new Error('Rate limit exceeded.');
      error.code = 'RATE_LIMITED';
      next(error);
    },
  }));
  app.use(express.json({ limit: '16kb' }));
  app.use(cookieParser());

  const health = (req, res) => res.json({
    success: true,
    data: { status: 'ok' },
    meta: { requestId: req.id },
  });
  app.get('/health', health);
  app.get('/api/v1/health', health);
  app.get('/ready', (req, res) => {
    const databaseStatus = database?.getStatus() ?? 'disconnected';
    const ready = app.locals.ready && databaseStatus === 'connected';
    return res.status(ready ? 200 : 503).json({
      success: ready,
      data: {
        status: !app.locals.ready ? 'shutting_down' : ready ? 'ready' : 'not_ready',
        checks: {
          application: app.locals.ready ? 'ready' : 'shutting_down',
          database: databaseStatus,
        },
      },
      meta: { requestId: req.id },
    });
  });

  let authService;
  if (typeof database?.connection?.model === 'function') {
    authService = createAuthService({
      UserAccount: getUserAccountModel(database.connection),
      GymAccess: getGymAccessModel(database.connection), Gym: getGymModel(database.connection),
      AuthSession: getAuthSessionModel(database.connection),
      RefreshTokenRecord: getRefreshTokenModel(database.connection), config, logger,
    });
    app.use('/api/v1/auth', createAuthRouter(authService, config));
    const authorizationService = createAuthorizationService({
      GymAccess: getGymAccessModel(database.connection), Gym: getGymModel(database.connection),
      Branch: getBranchModel(database.connection),
    });
    const staffService = createStaffService({ UserAccount: getUserAccountModel(database.connection),
      GymAccess: getGymAccessModel(database.connection), Gym: getGymModel(database.connection), authorizationService, logger });
    app.use('/api/v1/gyms/:gymId/staff', createStaffRouter(staffService, authService, createAuthorizationMiddleware(authorizationService)));
    const dashboardService = createDashboardService({ Gym: getGymModel(database.connection), Branch: getBranchModel(database.connection),
      MemberProfile: getMemberProfileModel(database.connection), TrainerProfile: getTrainerProfileModel(database.connection),
      MembershipPlan: getMembershipPlanModel(database.connection), MemberSubscription: getMemberSubscriptionModel(database.connection),
      Payment: getPaymentModel(database.connection), Attendance: getAttendanceModel(database.connection), authorizationService });
    app.use('/api/v1/gyms/:gymId/dashboard', createDashboardRouter(dashboardService, authService,
      createAuthorizationMiddleware(authorizationService)));
    const summaryService = createMemberSummaryService({ MemberProfile: getMemberProfileModel(database.connection),
      Branch: getBranchModel(database.connection), TrainerProfile: getTrainerProfileModel(database.connection),
      TrainerMemberAssignment: getTrainerMemberAssignmentModel(database.connection), MemberSubscription: getMemberSubscriptionModel(database.connection),
      MembershipPlan: getMembershipPlanModel(database.connection), Payment: getPaymentModel(database.connection),
      Attendance: getAttendanceModel(database.connection), authorizationService });
    app.use('/api/v1/gyms/:gymId/members', createMemberSummaryRouter(summaryService, authService,
      createAuthorizationMiddleware(authorizationService)));
    const memberService = createMemberService({ MemberProfile: getMemberProfileModel(database.connection),
      Branch: getBranchModel(database.connection), UserAccount: getUserAccountModel(database.connection), authorizationService });
    app.use('/api/v1/gyms/:gymId/member-onboarding', createMemberOnboardingRouter(memberService, authService,
      createAuthorizationMiddleware(authorizationService)));
    app.use('/api/v1/gyms/:gymId/members', createMemberRouter(memberService, authService,
      createAuthorizationMiddleware(authorizationService)));
    const trainerService = createTrainerService({ TrainerProfile: getTrainerProfileModel(database.connection),
      Branch: getBranchModel(database.connection), UserAccount: getUserAccountModel(database.connection), authorizationService });
    app.use('/api/v1/gyms/:gymId/trainers', createTrainerRouter(trainerService, authService,
      createAuthorizationMiddleware(authorizationService)));
    const assignmentService = createAssignmentService({
      TrainerMemberAssignment: getTrainerMemberAssignmentModel(database.connection),
      TrainerProfile: getTrainerProfileModel(database.connection), MemberProfile: getMemberProfileModel(database.connection),
      authorizationService,
    });
    app.use('/api/v1/gyms/:gymId/trainer-assignments', createAssignmentRouter(assignmentService, authService,
      createAuthorizationMiddleware(authorizationService)));
    const planService = createPlanService({ MembershipPlan: getMembershipPlanModel(database.connection), authorizationService });
    app.use('/api/v1/gyms/:gymId/membership-plans', createPlanRouter(planService, authService,
      createAuthorizationMiddleware(authorizationService)));
    const subscriptionService = createSubscriptionService({ MemberSubscription: getMemberSubscriptionModel(database.connection),
      MemberProfile: getMemberProfileModel(database.connection), MembershipPlan: getMembershipPlanModel(database.connection),
      TrainerProfile: getTrainerProfileModel(database.connection), TrainerMemberAssignment: getTrainerMemberAssignmentModel(database.connection),
      authorizationService });
    app.use('/api/v1/gyms/:gymId/subscriptions', createSubscriptionRouter(subscriptionService, authService,
      createAuthorizationMiddleware(authorizationService)));
    const paymentService = createPaymentService({ Payment: getPaymentModel(database.connection),
      MemberSubscription: getMemberSubscriptionModel(database.connection), MemberProfile: getMemberProfileModel(database.connection),
      TrainerProfile: getTrainerProfileModel(database.connection), TrainerMemberAssignment: getTrainerMemberAssignmentModel(database.connection),
      authorizationService });
    app.use('/api/v1/gyms/:gymId/payments', createPaymentRouter(paymentService, authService,
      createAuthorizationMiddleware(authorizationService)));
    const memberMembershipService = createMemberMembershipService({ MemberSubscription: getMemberSubscriptionModel(database.connection),
      subscriptionService, paymentService, authorizationService });
    app.use('/api/v1/gyms/:gymId/member-memberships', createMemberMembershipRouter(memberMembershipService, authService,
      createAuthorizationMiddleware(authorizationService)));
    const membershipManagementService = createMembershipManagementService({ summaryService, subscriptionService, paymentService });
    app.use('/api/v1/gyms/:gymId/members/:memberId/memberships', createMembershipManagementRouter(membershipManagementService, authService,
      createAuthorizationMiddleware(authorizationService)));
    const attendanceService = createAttendanceService({ Gym: getGymModel(database.connection), Attendance: getAttendanceModel(database.connection),
      MemberProfile: getMemberProfileModel(database.connection), Branch: getBranchModel(database.connection),
      MemberSubscription: getMemberSubscriptionModel(database.connection), MembershipPlan: getMembershipPlanModel(database.connection),
      TrainerProfile: getTrainerProfileModel(database.connection), TrainerMemberAssignment: getTrainerMemberAssignmentModel(database.connection),
      authorizationService });
    app.use('/api/v1/gyms/:gymId/attendance', createAttendanceRouter(attendanceService, authService,
      createAuthorizationMiddleware(authorizationService)));
  }

  // Temporary unauthenticated bootstrap functionality, never a production authorization path.
  if (bootstrap && config.enableBootstrapRoutes && ['development', 'test'].includes(config.nodeEnv)) {
    if (!database?.connection) throw new Error('Bootstrap routes require a database connection.');
    const gymService = createGymService(getGymModel(database.connection));
    const branchService = createBranchService(getBranchModel(database.connection), gymService);
    const userService = createUserAccountService(getUserAccountModel(database.connection));
    const accessService = createGymAccessService(getGymAccessModel(database.connection), gymService, userService);
    logger.warn('Unauthenticated bootstrap routes enabled; local development only');
    app.use('/api/v1/user-accounts', bootstrapOnly, createUserAccountRouter(userService, authService, config));
    app.use('/api/v1/gyms/:gymId/access', bootstrapOnly, createGymAccessRouter(accessService));
    app.use('/api/v1/gyms', bootstrapOnly, createGymRouter(gymService, branchService));
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

// Construction is explicit: importing this module validates no environment and opens no sockets.
function createApp(options) { return buildApp({ ...options, bootstrap: false }); }
function createBootstrapApp(options) {
  const { config } = options;
  if (!config.enableBootstrapRoutes || !['development', 'test'].includes(config.nodeEnv)) {
    throw new Error('Bootstrap listener requires explicit development/test enablement.');
  }
  return buildApp({ ...options, bootstrap: true });
}
module.exports = { createApp, createBootstrapApp };
