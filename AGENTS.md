# Gym Management System Backend

## 1. PROJECT PURPOSE

This is a production-oriented REST API for the Gym Management System, not a tutorial or demo. The system will support Admin, Trainer, and Member roles across multiple gyms/branches.

Approved backend stack:

- Node.js 24
- Express 5
- JavaScript
- CommonJS initially
- MongoDB with Mongoose
- JWT authentication
- Zod validation
- Helmet
- CORS where required
- Pino / pino-http for structured logging
- Supertest for HTTP integration tests
- ESLint for linting

## 2. ARCHITECTURE

Expected high-level flow:

```text
Client
→ Express API
→ controllers/routes
→ services
→ repositories/data access where useful
→ Mongoose
→ MongoDB
```

- Keep routes/controllers thin.
- Business logic belongs in services.
- Database access must not be scattered throughout controllers.
- Keep validation separate from business logic.
- Avoid unnecessary abstraction and generic CRUD frameworks.
- Do not introduce a repository layer for every model unless it provides real value.

## 3. DATABASE

- MongoDB is the approved database. Use Mongoose.
- Design schemas carefully, considering indexes, ownership, gym/branch scope, timestamps, and data integrity.
- Never trust client-supplied gymId, role, ownership, or permissions. Derive or verify these against trusted server-side data and authorization rules.
- Ensure data access respects authorized gym/branch scope and prevents access across unauthorized gyms/branches.

## 4. AUTHENTICATION

- Passwords must be securely hashed. Never store plaintext passwords.
- Never log passwords or tokens.
- Use short-lived access JWTs and rotating refresh tokens with appropriate lifetimes.
- Enforce refresh-token rotation and session/refresh-token revocation server-side.
- Use secure client-side token storage appropriate to the client platform.
- JWT decoding on the client is not authorization.

## 5. AUTHORIZATION

The backend is the source of truth for authorization.

Every protected operation must verify:

- Authenticated user
- Account status
- Role/capability
- Gym/branch scope
- Resource ownership or assignment where applicable

Examples:

- Members can access their own records.
- Trainers can access only permitted assigned-member records.
- Admins can manage records within their authorized gym scope.

## 6. VALIDATION

- Use Zod for request/configuration validation where appropriate.
- Never rely on Flutter/client validation alone.
- Validate input before it reaches business logic.

## 7. SECURITY

- Never commit secrets.
- Use environment variables for secrets/configuration.
- Add appropriate security headers using Helmet.
- Configure CORS intentionally and only where required.
- Do not expose stack traces or sensitive internal errors to clients.
- Sanitize logs.
- Use HTTPS in deployed environments.
- Do not weaken security to make development easier.

## 8. ERROR HANDLING

- Use centralized error handling.
- Return consistent API error responses.
- Distinguish validation, authentication, authorization, not-found, conflict, rate-limit, and unexpected server errors.
- Keep client-facing errors safe while retaining sanitized diagnostic details in server logs.

## 9. API DESIGN

- Use versioned API routes, for example `/api/v1/...`.
- Keep request/response contracts explicit and consistent.
- Do not invent API contracts without approval.

## 10. LOGGING

- Use Pino / pino-http for structured logging.
- Do not log passwords, JWTs, refresh tokens, credentials, or sensitive personal information.
- Sanitize logged data and redact sensitive fields.

## 11. TESTING

- Test important business logic and API behavior.
- Use Supertest for HTTP integration tests.
- Test authorization and ownership rules, not only successful requests.
- Cover account status, role/capability, gym/branch isolation, and assignment restrictions where applicable.

## 12. CONFIGURATION

- Use environment variables.
- When configuration is implemented, provide an `.env.example` without real secrets and exclude `.env` from Git.
- Never commit `.env`.
- Separate development, staging, and production configuration appropriately.
- Validate configuration with Zod where appropriate.

## 13. GIT

- Keep changes focused.
- Do not modify unrelated files.
- Prefer small logical commits.
- Never commit secrets.
- Create a Git commit only when requested or authorized by the user.

## 14. AI AGENT BEHAVIOR

Before implementing a task:

- Inspect relevant existing code.
- Understand the current architecture.
- Explain important assumptions.
- Follow the approved architecture.

Do not:

- Rewrite unrelated code.
- Introduce unnecessary packages.
- Create duplicate business logic.
- Bypass validation.
- Weaken authentication/authorization.
- Invent API contracts without approval.
- Modify database structure without considering existing data.
- Implement the entire backend in one step.

Follow the user's requested scope. These guidelines do not authorize creating configuration files, installing dependencies, or implementing features outside the current task.

## 15. DEVELOPMENT WORKFLOW

```text
Requirements
→ API/data design
→ Implementation
→ Tests
→ Validation
→ Review
→ Git commit (when requested or authorized)
```

For significant features, stop at the requested scope and wait for further instructions.
