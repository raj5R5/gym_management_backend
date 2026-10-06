const { getUserAccountModel } = require('../modules/userAccounts/userAccount.model');
const { getGymAccessModel } = require('../modules/gymAccess/gymAccess.model');

function identityModels(connection) {
  return [getUserAccountModel(connection), getGymAccessModel(connection)];
}

async function verifyIdentityIndexes(connection) {
  for (const model of identityModels(connection)) {
    let indexes;
    try { indexes = await model.listIndexes(); }
    catch (error) {
      if (error.code !== 26) throw error;
      indexes = [];
    }
    for (const [key, options] of model.schema.indexes().filter(([, options]) => options.unique)) {
      const found = indexes.some((index) => index.unique === true && !index.sparse && !index.partialFilterExpression
        && (!index.collation || index.collation.locale === 'simple')
        && JSON.stringify(index.key) === JSON.stringify(key));
      if (!found) {
        const error = new Error(`Required identity index missing: ${options.name}. Run the identity index migration before startup.`);
        error.code = 'IDENTITY_INDEX_MISSING';
        throw error;
      }
    }
  }
}

async function migrateIdentityIndexes(connection) {
  // Add declared indexes only: never sync/drop unrelated indexes or alter stored data.
  for (const model of identityModels(connection)) await model.createIndexes();
  await verifyIdentityIndexes(connection);
}

module.exports = { verifyIdentityIndexes, migrateIdentityIndexes };
