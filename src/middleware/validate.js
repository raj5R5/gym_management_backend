function validate(schemas) {
  return (req, _res, next) => {
    req.validated = {};
    for (const [source, schema] of Object.entries(schemas)) {
      const result = schema.safeParse(req[source]);
      if (!result.success) {
        const error = new Error('Request validation failed.');
        error.code = 'VALIDATION_ERROR';
        return next(error);
      }
      req.validated[source] = result.data;
    }
    return next();
  };
}

module.exports = validate;
