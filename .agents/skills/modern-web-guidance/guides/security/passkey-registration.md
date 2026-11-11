# Passkey Registration

This guide details how to enable users to register a passkey for their account, providing a highly secure, phishing-resistant passwordless sign-in alternative.

## Database Requirements

To support passkey registrations, your database credential table must store the following fields:

```typescript
export interface StoredPasskeyCredential {
  id: string; // Base64URL-encoded credential ID (unique lookup key)
  passkeyUserId: string; // Associated application user ID
  credentialPublicKey: string; // Base64URL-encoded public key used to verify assertion signatures
  credentialType: "public-key";
  credentialDeviceType: "singleDevice" | "multiDevice"; // Helps distinguish device-bound vs cloud-synced passkeys
  credentialBackedUp: boolean; // Boolean backup state reported by the authenticator
  aaguid: string; // Authenticator Attestation GUID
  providerIcon?: string; // Provider icon derived from the AAGUID registry (dark or light theme URLs)
  name: string; // Provider name derived from AAGUID registry
  transports: string[]; // Array of transport names (e.g. 'internal', 'hybrid') necessary for exclusion options
  lastUsedAt?: number; // Optional epoch timestamp of last sign-in
  registeredAt: number; // Registration epoch timestamp
  counter: number; // Authenticator sign-in signature counter used to prevent replay attacks
}
```

## Server-Side

### Options Generation

Create an endpoint that generates WebAuthn creation parameters. Rely on a vetted library per category standards instead of hand-rolling cryptography.

1.  **Use the predefined RP ID**: Use the predefined proper RP ID as a constant string in `rp.id` so the client can pass `publicKey.rp.id` directly to Signal API calls.
2.  **Create a secure Challenge**: Generate a high-entropy, cryptographically secure random buffer on the server, store it securely in the user's session, and encode it as Base64URL for options delivery.
3.  **Avoid Duplicate Passkeys**: Map the user's existing pre-registered credential IDs to the `excludeCredentials` options array. This prevents the authenticator from registering duplicate credentials on the same passkey provider account.
4.  **Enforce Discoverable Credentials**: Set `requireResidentKey: true` and `residentKey: "required"` in the `authenticatorSelection` options to request a discoverable credential, which is necessary for discoverable sign-ins.
5.  **Configure User Verification**: Specify `userVerification: "preferred"` or `userVerification: "required"`. Many compliance use cases (e.g., finance, healthcare) require `'required'` to enforce user verification on creation.
6.  **Determine Attachment Scope**:
    - **Promotion Flow**: When proposing passkey creation right after standard password sign-ins or post-signup promotions, set `authenticatorAttachment: "platform"` to enforce platform authenticator and bypass external security key prompts.
    - **Management Flow**: When called from a dedicated settings or security panel where external security keys are supported in addition to platform authenticator, omit the `authenticatorAttachment` property entirely.
    - _Tip_: Accept a `promotion: boolean` request flag to conditionally handle both flows with a single endpoint.

```javascript
// Options generation example
const options = {
  challenge: serverGeneratedBase64UrlChallenge, // Cryptographically random challenge
  rp: { id: "example.com", name: "Secure Application" },
  user: {
    id: userBase64UrlId, // Unique base64url string identifying the account
    name: "user@example.com",
    displayName: "Jane Doe",
  },
  pubKeyCredParams: [
    {
      type: "public-key",
      alg: -7,
    },
    {
      type: "public-key",
      alg: -257,
    },
  ],
  excludeCredentials: userExistingCredentials.map((cred) => ({
    type: "public-key",
    id: cred.id,
    transports: cred.transports,
  })),
  authenticatorSelection: {
    residentKey: "required",
    requireResidentKey: true,
    userVerification: "preferred",
    ...(isPromotionFlow && { authenticatorAttachment: "platform" }),
  },
};
```

### Verification

1.  **Challenge Verification**: Securely verify the challenge against the expected session bound challenge.
2.  **Verify User Presence**:
    - Ensure that the User Present (UP) flag returned in the parsed authenticator data is `true` to confirm physical user presence at the time of creation.
3.  **Relaxing Verification for 'preferred'**:
    - When the creation options specified `userVerification: "preferred"`, the server-side verification call MUST be configured with `requireUserVerification: false`. Otherwise, authenticators that register without user verification (e.g., screen locks disabled) will trigger spurious server verification failures.

## Client-Side Logic

1.  **Check basic WebAuthn support on page load**:
    - Enable explicit registration when `PublicKeyCredential` and `navigator.credentials.create` are available.
    - Do not require `conditionalGet` or `passkeyPlatformAuthenticator` for explicit registration with an external security key.
    - Use capability checks only for the optional flow they describe, such as platform-only promotion.
2.  **Invoke creation & Serialize**: Decode server options with `PublicKeyCredential.parseCreationOptionsFromJSON()` and pass the resulting configuration to `navigator.credentials.create()`.
    - Call `credential.toJSON()` to encode the `AuthenticatorAttestationResponse` into a valid, JSON-serializable object before fetching the verification endpoint.
3.  **Handle WebAuthn Exceptions**:
    - `InvalidStateError`: A matching passkey already exists (matched by `excludeCredentials`).
    - `NotAllowedError`: The user cancelled or timed out the authentication passkey dialog.
    - `AbortError`: The operation has been aborted.
    - `SecurityError`: Secure origins (HTTPS) or RP ID mismatch errors (configuration issues).
4.  **Separate server verification from Signal API errors**:
    - Signal an unknown credential only after the server confirms that this credential was not persisted.
    - In this example, a rejected verification response contains `credentialPersisted: false` only when the server has confirmed that the credential is absent. A non-OK status alone is not enough.
    - Keep the credential after a network error, a lost response, or an unclear server error. Reconcile its state with the server before cleanup or another registration attempt.
    - After verification, return `success` only for an OK response, `rejected` only for confirmed absence, and `unresolved` for other outcomes. The caller must display the status and reconcile `unresolved` states with the server before retrying.
    - Catch Signal API errors separately. A failed synchronization must not change the registration result.
    - Always read `rpId` from `publicKey.rp.id` in the server's creation options. **DO NOT** derive `rpId` from `window.location.hostname` on the client, as the server's configured RP ID may be a registrable parent domain (such as `example.com` on `accounts.example.com`) or use Related Origin Requests.

```javascript
// optionsFetch and registerVerifyFetch are app-defined HTTP methods
import { optionsFetch, registerVerifyFetch } from "./api.js";

async function registerPasskey(isPromotion = false) {
  // Explicit registration also supports external security keys.
  if (!globalThis.PublicKeyCredential || !navigator.credentials?.create) {
    showStandardPasswordFallbackUI();
    return;
  }

  // Only platform-only promotion uses this optional capability check.
  if (isPromotion && PublicKeyCredential.getClientCapabilities) {
    const capabilities = await PublicKeyCredential.getClientCapabilities();
    if (capabilities.passkeyPlatformAuthenticator === false) {
      return;
    }
  }

  const creationOptionsJSON = await optionsFetch({ promotion: isPromotion });
  const publicKey =
    PublicKeyCredential.parseCreationOptionsFromJSON(creationOptionsJSON);

  let credential;
  try {
    // passkey prompt execution
    credential = await navigator.credentials.create({ publicKey });
  } catch (err) {
    if (err.name === "InvalidStateError") {
      console.log("A passkey already exists for this account.");
      alert("A passkey already exists for this account.");
    } else if (err.name === "SecurityError") {
      console.error("Configuration RP ID or Secure Context error.");
      alert("Configuration RP ID or Secure Context error.");
    } else if (err.name === "NotAllowedError") {
      console.log("User cancelled the passkey dialog.");
    } else if (err.name === "AbortError") {
      console.log("The creation operation has been aborted.");
    }
    return; // Safe API exit, do not signal unknown for standard WebAuthn cancels
  }

  const encodedResponse = credential.toJSON();
  let status = "unresolved";
  try {
    const response = await registerVerifyFetch(encodedResponse);
    if (response.ok) {
      status = "success";
    } else {
      const result = await response.json();
      if (result?.credentialPersisted === false) status = "rejected";
    }
  } catch (serverErr) {
    // The server may have saved the credential before its response was lost.
    console.error("Registration state is unknown; reconcile with the server:", serverErr);
  }

  if (status === "rejected" && PublicKeyCredential.signalUnknownCredential) {
    try {
      await PublicKeyCredential.signalUnknownCredential({
        rpId: publicKey.rp.id, // Use the server-provided RP ID.
        credentialId: encodedResponse.id,
      });
    } catch (signalErr) {
      console.warn("Credential synchronization failed:", signalErr);
    }
  }
  return status;
}
```

## Fallback Strategies

### Signal API Synchronization Fallback

Browser support for Web authentication signal methods: Limited availability.
Supported by: Chrome 132 (Jan 2025), Edge 132 (Jan 2025), and Safari 26 (Sep 2025).
Unsupported in: Firefox.

The WebAuthn Signal API (`webauthn-signals`) is a progressive optimization used to keep password managers in sync with the server credential state.

- **Fallback Experience**: If `PublicKeyCredential.signalUnknownCredential` is unsupported by the browser, the call MUST be bypassed safely via feature detection gating (`if (PublicKeyCredential.signalUnknownCredential)`), and the server-side verification simply logs the failure without triggering manager updates.

### Easy JSON Serialization Fallback

Baseline status for the api.PublicKeyCredential.parseCreationOptionsFromJSON_static capability: Newly available. It's been Baseline since 2025-03-31.
Supported by: Chrome 129 (Sep 2024), Edge 129 (Sep 2024), Firefox 119 (Oct 2023), and Safari 18.4 (Mar 2025).

Load `webauthn-polyfills` so `PublicKeyCredential.parseCreationOptionsFromJSON()` and `PublicKeyCredential.prototype.toJSON()` are available whenever `PublicKeyCredential` is supported:

```js
// With a bundler (`npm install webauthn-polyfills`):
import 'webauthn-polyfills';
```

Without a bundler, serve the package from your own origin, or import it from a CDN such as `https://esm.sh/webauthn-polyfills@0.1.7` (pin the exact version). For third-party URLs, add Subresource Integrity: the `integrity` attribute on the `<script>` tag, or an import map's `integrity` field for `import` statements.
