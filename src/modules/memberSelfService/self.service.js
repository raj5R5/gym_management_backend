const { listInput, empty } = require('./self.validation');
function createMemberSelfService({ summaryService }) {
  return {
    async read(auth, authorization, kind, query) {
      const parsed = (kind === 'profile' ? empty : listInput).safeParse(query);
      if (!parsed.success) { const error = new Error('Invalid self-service query.'); error.code = 'VALIDATION_ERROR'; throw error; }
      return summaryService.selfRead(auth, authorization, kind, parsed.data);
    },
  };
}
module.exports = { createMemberSelfService };
