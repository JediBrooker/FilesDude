import crypto from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

// A software passkey for tests: creates and signs WebAuthn responses as a browser and authenticator
// would, with a P-256 key and "none" attestation.
const sha256 = (data: Buffer | string) => crypto.createHash("sha256").update(data).digest();
const b64 = (data: Buffer | Uint8Array) => Buffer.from(data).toString("base64url");

export type RegistrationOptions = { challenge: string; rp: { id?: string }; user: { id: string } };
export type SignInOptions = { challenge: string; rpId?: string };

export class SoftAuthenticator {
  readonly keys = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  readonly credentialId = crypto.randomBytes(32);
  counter = 0;
  userHandle = "";
  rpId = "";

  constructor(private readonly options: { userVerified?: boolean; counting?: boolean } = {}) {}

  get id() {
    return b64(this.credentialId);
  }

  private publicKey() {
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    return isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
  }

  private authenticatorData(rpId: string, attested: boolean) {
    const flags = 0x01 | (this.options.userVerified === false ? 0 : 0x04) | 0x08 | 0x10 | (attested ? 0x40 : 0);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const parts = [sha256(rpId), Buffer.from([flags]), counter];
    if (attested) {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), length, this.credentialId, Buffer.from(this.publicKey()));
    }
    return Buffer.concat(parts);
  }

  register(options: RegistrationOptions, origin: string) {
    this.rpId = options.rp.id ?? new URL(origin).hostname;
    this.userHandle = options.user.id;
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false }));
    const attestationObject = isoCBOR.encode(new Map<string, string | Map<string, string> | Uint8Array>([["fmt", "none"], ["attStmt", new Map<string, string>()], ["authData", this.authenticatorData(this.rpId, true)]]));
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: b64(clientDataJSON), attestationObject: b64(attestationObject), transports: ["internal"] }, clientExtensionResults: {} };
  }

  signIn(options: SignInOptions, origin: string, overrides: { userHandle?: string; rpId?: string } = {}) {
    if (this.options.counting) this.counter += 1;
    const authenticatorData = this.authenticatorData(overrides.rpId ?? options.rpId ?? this.rpId, false);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
    const signature = crypto.sign("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.keys.privateKey);
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: b64(clientDataJSON), authenticatorData: b64(authenticatorData), signature: b64(signature), userHandle: overrides.userHandle ?? this.userHandle }, clientExtensionResults: {} };
  }
}
