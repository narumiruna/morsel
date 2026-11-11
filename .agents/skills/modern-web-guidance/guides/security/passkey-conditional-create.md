# Passkey Conditional Create (Post-Login Promotion)

This guide details how to automatically and silently register a passkey for a user immediately after a successful password-based sign-in, minimizing friction and boosting passkey adoption.

## The Right Trigger Moment

Automatic passkey creation (also known as Conditional Create or silent post-login promotion) MUST only be triggered **immediately after a successful, full sign-in that involved a password**.
* Do not attempt conditional creation for passwordless flows (e.g., magic links, SMS OTP, or identity federation).
* If multi-factor authentication is required, you MUST wait until all factors have succeeded before initiating conditional creation.
* Ensure a valid, authenticated user session is active before making requests to creation endpoints.

## Implementation Steps

### 1. Abort Prior Autofill Actions
If the sign-in page utilizes form autofill (Conditional UI/Get), the active credential get call must be aborted to prevent browser conflicts.
* Call `abortController.abort()` on the `AbortController` attached to the pending `navigator.credentials.get()` autofill request before calling `navigator.credentials.create()`.

### 2. Feature Detection
Determine whether Conditional Create is available by checking `conditionalCreate` with `PublicKeyCredential.getClientCapabilities()`.

```javascript
const capabilities = await PublicKeyCredential.getClientCapabilities();
if (capabilities.conditionalCreate) {
  // Conditional create is available
}
```

### 3. Create a passkey with Conditional Create
* Ensure the server's registration options endpoint includes the predefined RP ID in `rp.id` so `publicKey.rp.id` is populated if `PublicKeyCredential.signalUnknownCredential()` runs in Step 6, because omitting `rp.id` in WebAuthn creation options leaves `publicKey.rp.id` undefined on the client.
* Populate `excludeCredentials` with the user's existing passkey credential IDs to avoid registering duplicate keys.
* Pass `mediation: 'conditional'` within the `navigator.credentials.create()` options. This signals the browser to handle the passkey creation flow silently in the background or contextually without throwing obtrusive modal dialogs.

### 4. Silent Error Handling
* Wrap the passkey creation prompt (`navigator.credentials.create`) in a try/catch block. You MUST catch and silently ignore typical user-facing exceptions (`InvalidStateError`, `NotAllowedError`, `AbortError`) without rendering any error UI to the user.

### 5. Server-Side User Presence Verification
* The server-side verification endpoint MUST relax the User Presence (UP) requirement (`requireUserPresence: false`) **ONLY** when verifying credentials produced by a conditional-create trigger. Strict presence verification must remain active for standard explicit creations.

### 6. Handle Failed Server Verification gracefully
* Signal an unknown credential only after the server confirms that the credential was not persisted. In this example, a rejected response contains `credentialPersisted: false` only after the server confirms that the credential is absent.
* A network error, a lost response, or a non-OK status alone does not prove that registration failed. Keep the credential and reconcile its state with the server before cleanup or another registration attempt.
* Always read `rpId` from `publicKey.rp.id` in the server's creation options. Do not derive it from `window.location.hostname`, which can differ from a parent-domain or related-origin RP ID.
* Catch Signal API errors separately. A failed synchronization must not change the registration result.

## Code Example

```javascript
// optionsFetch and registerVerifyFetch are app-defined server endpoint requests
import { optionsFetch, registerVerifyFetch } from './api.js';

async function triggerConditionalCreate(loginAbortController) {
  const capabilities = await PublicKeyCredential.getClientCapabilities();
  if (capabilities.conditionalCreate !== true) {
    return; // Platform does not support conditional creation
  }

  // 1. Abort any active autofill conditional-get controllers to clear the WebAuthn pipeline
  loginAbortController.abort();

  // 2. Fetch creation options signaling the backend that this is a conditional request (server options must include rp.id)
  const creationOptionsJSON = await optionsFetch({ conditional: true });
  const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(creationOptionsJSON);

  let credential;
  try {
    // 3. Invoke silent credentials creation prompt
    credential = await navigator.credentials.create({
      publicKey,
      mediation: 'conditional' // Silent background creation mediation
    });
  } catch (e) {
    // 4. Silently swallow common WebAuthn browser exceptions
    if (['InvalidStateError', 'NotAllowedError', 'AbortError'].includes(e.name)) {
      return;
    }
    console.error('Unexpected conditional create error:', e);
    return;
  }

  // 5. Verify on the server before any credential cleanup.
  const encodedResponse = credential.toJSON();
  let credentialNotPersisted = false;
  try {
    const response = await registerVerifyFetch(encodedResponse);
    if (!response.ok) {
      const result = await response.json();
      credentialNotPersisted = result.credentialPersisted === false;
    }
  } catch (serverErr) {
    // The server may have saved the credential before its response was lost.
    console.error('Registration state is unknown; reconcile with the server:', serverErr);
  }

  if (credentialNotPersisted && PublicKeyCredential.signalUnknownCredential) {
    try {
      await PublicKeyCredential.signalUnknownCredential({
        rpId: publicKey.rp.id, // Use the server-provided RP ID.
        credentialId: encodedResponse.id
      });
    } catch (signalErr) {
      console.warn('Credential synchronization failed:', signalErr);
    }
  }
}
```

## Fallback Strategies

### Passkey feature detection fallback

Baseline status for the api.PublicKeyCredential.getClientCapabilities_static capability: Newly available. It's been Baseline since 2025-02-06.
Supported by: Chrome 133 (Feb 2025), Edge 133 (Feb 2025), Firefox 135 (Feb 2025), and Safari 17.4 (Mar 2024).

Load `webauthn-polyfills` so `PublicKeyCredential.getClientCapabilities()` is available whenever `PublicKeyCredential` is supported:

```js
// With a bundler (`npm install webauthn-polyfills`):
import 'webauthn-polyfills';
```

Without a bundler, serve the package from your own origin, or import it from a CDN such as `https://esm.sh/webauthn-polyfills@0.1.7` (pin the exact version). For third-party URLs, add Subresource Integrity: the `integrity` attribute on the `<script>` tag, or an import map's `integrity` field for `import` statements.

### Signal API Synchronization Fallback

Browser support for Web authentication signal methods: Limited availability.
Supported by: Chrome 132 (Jan 2025), Edge 132 (Jan 2025), and Safari 26 (Sep 2025).
Unsupported in: Firefox.

The WebAuthn Signal API (`webauthn-signals`) is a progressive optimization used to keep password managers in sync with the server credential state.
*   **Fallback Experience**: Gated via `if (PublicKeyCredential.signalUnknownCredential)`. If unsupported, the background verification sync is bypassed gracefully without throwing browser exceptions.

### Easy JSON Serialization Fallback

Baseline status for the api.PublicKeyCredential.parseCreationOptionsFromJSON_static capability: Newly available. It's been Baseline since 2025-03-31.
Supported by: Chrome 129 (Sep 2024), Edge 129 (Sep 2024), Firefox 119 (Oct 2023), and Safari 18.4 (Mar 2025).

Load `webauthn-polyfills` so `PublicKeyCredential.parseCreationOptionsFromJSON()` and `PublicKeyCredential.prototype.toJSON()` are available whenever `PublicKeyCredential` is supported:

```js
// With a bundler (`npm install webauthn-polyfills`):
import 'webauthn-polyfills';
```

Without a bundler, serve the package from your own origin, or import it from a CDN such as `https://esm.sh/webauthn-polyfills@0.1.7` (pin the exact version). For third-party URLs, add Subresource Integrity: the `integrity` attribute on the `<script>` tag, or an import map's `integrity` field for `import` statements.
