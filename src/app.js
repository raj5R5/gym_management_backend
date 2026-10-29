const { getDeletionFulfillmentModel } = require('./modules/accountDeletion/fulfillment.model');
const { getPasswordRecoveryModel } = require('./modules/passwordRecovery/recovery.model');
const { createRecoveryService } = require('./modules/passwordRecovery/recovery.service');
const { createRecoveryRouter } = require('./modules/passwordRecovery/recovery.routes');
const { createRecoveryDelivery } = require('./modules/passwordRecovery/recovery.delivery');
const { createPrivacyPolicyRouter } = require('./modules/privacyPolicy/privacy.routes');
const { getAccountDeletionRequestModel } = require('./modules/accountDeletion/model');
const { createAccountDeletionService } = require('./modules/accountDeletion/service');
const { createAccountDeletionRouter, createPublicDeletionRouter } = require('./modules/accountDeletion/routes');
const { getDeletionJobModel } = require('./modules/accountDeletion/automation.model');
const { createDeletionAutomation } = require('./modules/accountDeletion/automation.service');
const { createDeletionAdapters } = require('./modules/accountDeletion/automation.adapters');
const { createAccountDeletionAutomationRouter } = require('./modules/accountDeletion/automation.routes');
const { getOwnerProfileModel } = require('./modules/ownerProfile/profile.model');
const { createOwnerProfileService } = require('./modules/ownerProfile/profile.service');
const { createOwnerProfileRouter } = require('./modules/ownerProfile/profile.routes');
const { photoModels } = require('./modules/memberPhotos/photo.model');
const { createPhotoService } = require('./modules/memberPhotos/photo.service');
const { createPhotoStorage } = require('./modules/memberPhotos/photo.storage');
const { createPhotoRouter } = require('./modules/memberPhotos/photo.routes');
const { getRenewalOperationModel } = require('./modules/subscriptions/renewal_operation.model');
const { createRenewalService } = require('./modules/subscriptions/renewal.service');
const { getMemberOnboardingOperationModel } = require('./modules/memberOnboardingComplete/operation.model');
const { createCompleteOnboardingService } = require('./modules/memberOnboardingComplete/complete.service');
const { createCompleteOnboardingRouter } = require('./modules/memberOnboardingComplete/complete.routes');
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
const express = require('express');
const { createSelfMemberResolver } = require('./modules/memberSelfService/self.authorization');
const { createMemberSelfService } = require('./modules/memberSelfService/self.service');
const { createMemberSelfRouter } = require('./modules/memberSelfService/self.routes');
const { getMemberActivationModel } = require('./modules/memberAccount/activation.model');
const { createMemberAccountService } = require('./modules/memberAccount/account.service');
const { createMemberAccountRouter, createAccountActivationRouter } = require('./modules/memberAccount/account.routes');
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
const { createAssignmentRouter, createAssignmentViewsRouter } = require('./modules/trainerAssignments/assignment.routes');
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
const { createOwnerRegistrationService } = require('./modules/ownerRegistration/registration.service');
const { createOwnerRegistrationRouter } = require('./modules/ownerRegistration/registration.routes');
const helmet = require('helmet');
const cors = require('cors');
const { createRequestLogger, routeTemplatePrefix } = require('./middleware/requestLogger');
const { rateLimit } = require('express-rate-limit');
const { createLogger } = require('./config/logger');
const requestId = require('./middleware/requestId');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');
const { getGymModel } = require('./modules/gyms/gym.model');
const { createGymService } = require('./modules/gyms/gym.service');
const { createGymRouter } = require('./modules/gyms/gym.routes');
const bootstrapOnly = require('./middleware/bootstrapOnly');
const { getUserAccountModel } = require('./modules/userAccounts/userAccount.model');
const { createUserAccountService } = require('./modules/userAccounts/userAccount.service');
const { createUserAccountRouter } = require('./modules/userAccounts/userAccount.routes');
const { getGymAccessModel } = require('./modules/gymAccess/gymAccess.model');
const { createGymAccessService } = require('./modules/gymAccess/gymAccess.service');
const { createGymAccessRouter } = require('./modules/gymAccess/gymAccess.routes');

function buildApp({ config, logger = createLogger(config), database, photoStorage, ownerPhotoStorage, recoveryDelivery, bootstrap = false } = {}) {
  const app = express();
  const mountRouter = (path, ...handlers) => app.use(path, routeTemplatePrefix(path), ...handlers);
  app.disable('x-powered-by');
  // Trust only explicitly configured proxy addresses, never arbitrary forwarding headers.
  app.set('trust proxy', config.trustedProxies?.length ? [...config.trustedProxies] : false);
  app.locals.config = config;
  app.locals.logger = logger;
  app.locals.ready = true;

  app.use(requestId);
  app.use(createRequestLogger(logger));
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
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'Idempotency-Key'],
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
  mountRouter('/privacy-policy', createPrivacyPolicyRouter());
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
    mountRouter('/api/v1/auth', createAuthRouter(authService, config));
    const recoveryService = createRecoveryService({ UserAccount: getUserAccountModel(database.connection),
      AuthSession: getAuthSessionModel(database.connection), RefreshTokenRecord: getRefreshTokenModel(database.connection),
      PasswordRecovery: getPasswordRecoveryModel(database.connection), delivery: recoveryDelivery ?? createRecoveryDelivery(config),
      ttl: config.recovery?.ttl ?? 900, logger });
    app.locals.recoveryService = recoveryService;
    mountRouter('/api/v1/auth', createRecoveryRouter(recoveryService));
    // Internal cases have no HTTP completion/admin endpoint.
    getDeletionFulfillmentModel(database.connection);
    getDeletionJobModel(database.connection);
    const deletionService = createAccountDeletionService({ UserAccount: getUserAccountModel(database.connection),
      AccountDeletionRequest: getAccountDeletionRequestModel(database.connection) });
    // Mounted after every model is registered (end of this block) when automation is enabled.
    const mountDeletion = (engine) => {
      mountRouter('/api/v1/auth', createAccountDeletionRouter(deletionService, authService, { automated: Boolean(engine) }));
      if (engine) mountRouter('/api/v1/auth', createAccountDeletionAutomationRouter(engine, authService));
      mountRouter('/account-deletion', createPublicDeletionRouter(deletionService, engine));
    };
    const ownerRegistrationService = createOwnerRegistrationService({
      UserAccount: getUserAccountModel(database.connection), Gym: getGymModel(database.connection),
      GymAccess: getGymAccessModel(database.connection),
    });
    mountRouter('/api/v1/auth', createOwnerRegistrationRouter(ownerRegistrationService));
    const authorizationService = createAuthorizationService({
      GymAccess: getGymAccessModel(database.connection), Gym: getGymModel(database.connection),

    });
    const ownerProfileService = createOwnerProfileService({ OwnerProfile: getOwnerProfileModel(database.connection),
      UserAccount: getUserAccountModel(database.connection), Gym: getGymModel(database.connection),
      authorizationService, storage: ownerPhotoStorage ?? createPhotoStorage(config, 'owner'), logger });
    app.locals.ownerPhotoService = ownerProfileService.photos;
    mountRouter('/api/v1/gyms/:gymId/owner-profile', createOwnerProfileRouter(ownerProfileService, authService,
      createAuthorizationMiddleware(authorizationService)));
    const staffService = createStaffService({ UserAccount: getUserAccountModel(database.connection),
      GymAccess: getGymAccessModel(database.connection), Gym: getGymModel(database.connection), authorizationService, logger });
    mountRouter('/api/v1/gyms/:gymId/staff', createStaffRouter(staffService, authService, createAuthorizationMiddleware(authorizationService)));
    const dashboardService = createDashboardService({ Gym: getGymModel(database.connection),
      MemberProfile: getMemberProfileModel(database.connection), TrainerProfile: getTrainerProfileModel(database.connection),
      MembershipPlan: getMembershipPlanModel(database.connection), MemberSubscription: getMemberSubscriptionModel(database.connection),
      Payment: getPaymentModel(database.connection), authorizationService });
    mountRouter('/api/v1/gyms/:gymId/dashboard', createDashboardRouter(dashboardService, authService,
      createAuthorizationMiddleware(authorizationService)));
    const summaryService = createMemberSummaryService({ Gym: getGymModel(database.connection), MemberProfile: getMemberProfileModel(database.connection),
      TrainerProfile: getTrainerProfileModel(database.connection),
      TrainerMemberAssignment: getTrainerMemberAssignmentModel(database.connection), MemberSubscription: getMemberSubscriptionModel(database.connection),
      MembershipPlan: getMembershipPlanModel(database.connection), Payment: getPaymentModel(database.connection),
      authorizationService,
      resolveSelfMember: createSelfMemberResolver({ MemberProfile: getMemberProfileModel(database.connection), authorizationService }) });
    mountRouter('/api/v1/me/gyms/:gymId', createMemberSelfRouter(createMemberSelfService({ summaryService }), authService,
      createAuthorizationMiddleware(authorizationService)));
    mountRouter('/api/v1/gyms/:gymId/members', createMemberSummaryRouter(summaryService, authService,
      createAuthorizationMiddleware(authorizationService)));
    const memberService = createMemberService({ MemberProfile: getMemberProfileModel(database.connection),
      UserAccount: getUserAccountModel(database.connection), authorizationService });
    const memberPhotoService = createPhotoService({ MemberProfile: getMemberProfileModel(database.connection),
      ...photoModels(database.connection), authorizationService, storage: photoStorage ?? createPhotoStorage(config), logger });
    app.locals.memberPhotoService = memberPhotoService;
    mountRouter('/api/v1/gyms/:gymId/members/:memberId/photo', createPhotoRouter(memberPhotoService, authService,
      createAuthorizationMiddleware(authorizationService)));
    const memberAccountService = createMemberAccountService({ MemberProfile: getMemberProfileModel(database.connection),
      UserAccount: getUserAccountModel(database.connection), GymAccess: getGymAccessModel(database.connection),
      Gym: getGymModel(database.connection), MemberActivation: getMemberActivationModel(database.connection), authorizationService, logger });
    mountRouter('/api/v1/account', createAccountActivationRouter(memberAccountService));
    mountRouter('/api/v1/gyms/:gymId/members/:memberId/account', createMemberAccountRouter(memberAccountService, authService,
      createAuthorizationMiddleware(authorizationService)));
    mountRouter('/api/v1/gyms/:gymId/member-onboarding', createMemberOnboardingRouter(memberService, authService,
      createAuthorizationMiddleware(authorizationService)));
    const subscriptionService = createSubscriptionService({ Gym: getGymModel(database.connection), MemberSubscription: getMemberSubscriptionModel(database.connection),
      MemberProfile: getMemberProfileModel(database.connection), MembershipPlan: getMembershipPlanModel(database.connection),
      TrainerProfile: getTrainerProfileModel(database.connection), TrainerMemberAssignment: getTrainerMemberAssignmentModel(database.connection),
      authorizationService });
    const paymentService = createPaymentService({ Gym: getGymModel(database.connection), Payment: getPaymentModel(database.connection),
      MemberSubscription: getMemberSubscriptionModel(database.connection), MemberProfile: getMemberProfileModel(database.connection),
      TrainerProfile: getTrainerProfileModel(database.connection), TrainerMemberAssignment: getTrainerMemberAssignmentModel(database.connection),
      authorizationService });
    const membershipManagementService = createMembershipManagementService({ summaryService, subscriptionService, paymentService });
    mountRouter('/api/v1/gyms/:gymId/members/:memberId/memberships', createMembershipManagementRouter(membershipManagementService, authService,
      createAuthorizationMiddleware(authorizationService)));
    // Specific member routes must reach their own guards before the general
    // Members router, whose router-wide middleware also runs on unmatched paths.
    mountRouter('/api/v1/gyms/:gymId/members', createMemberRouter(memberService, authService,
      createAuthorizationMiddleware(authorizationService)));
    const trainerService = createTrainerService({ TrainerProfile: getTrainerProfileModel(database.connection),
      UserAccount: getUserAccountModel(database.connection), authorizationService });
    mountRouter('/api/v1/gyms/:gymId/trainers', createTrainerRouter(trainerService, authService,
      createAuthorizationMiddleware(authorizationService)));
    const assignmentService = createAssignmentService({
      TrainerMemberAssignment: getTrainerMemberAssignmentModel(database.connection),
      TrainerProfile: getTrainerProfileModel(database.connection), MemberProfile: getMemberProfileModel(database.connection),

      authorizationService,
    });
    mountRouter('/api/v1/gyms/:gymId/trainer-assignments', createAssignmentRouter(assignmentService, authService,
      createAuthorizationMiddleware(authorizationService)));
    mountRouter('/api/v1/gyms/:gymId', createAssignmentViewsRouter(assignmentService, authService,
      createAuthorizationMiddleware(authorizationService)));
    const planService = createPlanService({ MembershipPlan: getMembershipPlanModel(database.connection), authorizationService });
    mountRouter('/api/v1/gyms/:gymId/membership-plans', createPlanRouter(planService, authService,
      createAuthorizationMiddleware(authorizationService)));
    const renewalService = createRenewalService({ RenewalOperation: getRenewalOperationModel(database.connection),
      subscriptionService, paymentService, authorizationService });
    mountRouter('/api/v1/gyms/:gymId/subscriptions', createSubscriptionRouter(subscriptionService, authService,
      createAuthorizationMiddleware(authorizationService), renewalService));
    mountRouter('/api/v1/gyms/:gymId/payments', createPaymentRouter(paymentService, authService,
      createAuthorizationMiddleware(authorizationService)));
    const completeOnboardingService = createCompleteOnboardingService({
      MemberOnboardingOperation: getMemberOnboardingOperationModel(database.connection),
      Gym: getGymModel(database.connection), GymAccess: getGymAccessModel(database.connection),
      UserAccount: getUserAccountModel(database.connection), memberService, subscriptionService, paymentService, authorizationService });
    mountRouter('/api/v1/gyms/:gymId/member-onboarding', createCompleteOnboardingRouter(completeOnboardingService, authService,
      createAuthorizationMiddleware(authorizationService)));
    const memberMembershipService = createMemberMembershipService({ MemberSubscription: getMemberSubscriptionModel(database.connection),
      subscriptionService, paymentService, authorizationService });
    mountRouter('/api/v1/gyms/:gymId/member-memberships', createMemberMembershipRouter(memberMembershipService, authService,
      createAuthorizationMiddleware(authorizationService)));
    let deletionEngine = null;
    const deletionMode = config.accountDeletion?.mode ?? 'disabled';
    if (deletionMode !== 'disabled') {
      const delivery = recoveryDelivery ?? createRecoveryDelivery(config);
      deletionEngine = createDeletionAutomation({ models: database.connection.models, authService, enabled: true,
        notificationKey: config.accountDeletion.noticeKey,
        adapters: createDeletionAdapters({ models: database.connection.models, delivery,
          photoServices: [ownerProfileService.photos, memberPhotoService], logger,
          operatorEmail: deletionMode === 'operator' ? config.recovery.from : null }) });
      app.locals.deletionEngine = deletionEngine;
      app.locals.deletionWorker = createDeletionWorker(deletionEngine, logger);
    }
    // Operator mode keeps request intake; only 'enabled' exposes self-service confirmation.
    mountDeletion(deletionMode === 'enabled' ? deletionEngine : null);
  }

  // Temporary unauthenticated bootstrap functionality, never a production authorization path.
  if (bootstrap && config.enableBootstrapRoutes && ['development', 'test'].includes(config.nodeEnv)) {
    if (!database?.connection) throw new Error('Bootstrap routes require a database connection.');
    const gymService = createGymService(getGymModel(database.connection));
    const userService = createUserAccountService(getUserAccountModel(database.connection));
    const accessService = createGymAccessService(getGymAccessModel(database.connection), gymService, userService);
    logger.warn('Unauthenticated bootstrap routes enabled; local development only');
    mountRouter('/api/v1/user-accounts', bootstrapOnly, createUserAccountRouter(userService, authService, config));
    mountRouter('/api/v1/gyms/:gymId/access', bootstrapOnly, createGymAccessRouter(accessService));
    mountRouter('/api/v1/gyms', bootstrapOnly, createGymRouter(gymService));
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

// Drains due deletion jobs once a minute; a failed pass keeps its durable retry.
function createDeletionWorker(engine, logger) {
  let timer; let running;
  async function drain() { for (let i = 0; i < 20 && await engine.processNext(); i++); }
  return {
    start() {
      if (timer) return;
      const run = () => {
        if (running) return;
        running = drain().catch(() => logger?.warn('Account deletion pass deferred')).finally(() => { running = null; });
      };
      timer = setInterval(run, 60_000); timer.unref(); run();
    },
    async stop() { clearInterval(timer); timer = null; await running; },
    drain,
  };
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
