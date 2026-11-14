const jsVersionActions = require('@nx/js/src/release/version-actions')
const { rewritingMarkedVersions } = require('./release-versions.js')

module.exports = {
  default: rewritingMarkedVersions(jsVersionActions.default),
  afterAllProjectsVersioned: jsVersionActions.afterAllProjectsVersioned,
}
