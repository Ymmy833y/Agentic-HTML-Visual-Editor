'use strict';

// Stands in for @azure/identity. @vscode/vsce loads it at startup but uses it only for --azure-credential (Microsoft
// Entra ID sign-in). The publish workflow signs in with a personal access token, so the real package and the MSAL
// libraries under it would never run; replacing it keeps them out of the job that receives the token and out of the
// audit.

/**
 * Fails as soon as vsce tries to build a credential, saying why instead of an unrelated TypeError.
 */
class UnavailableCredential {
  constructor() {
    throw new Error(
      'Microsoft Entra ID sign-in is unavailable: scripts/release replaces @azure/identity with a stub. '
        + 'Publish with a personal access token instead.',
    );
  }
}

// The credentials vsce builds in out/auth.js.
module.exports = {
  ChainedTokenCredential: UnavailableCredential,
  EnvironmentCredential: UnavailableCredential,
  AzureCliCredential: UnavailableCredential,
  ManagedIdentityCredential: UnavailableCredential,
  AzurePowerShellCredential: UnavailableCredential,
  AzureDeveloperCliCredential: UnavailableCredential,
};
