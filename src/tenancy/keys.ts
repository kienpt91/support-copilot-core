import { randomBytes, timingSafeEqual } from "node:crypto";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { type Clock, sha256Hex, systemClock } from "../util.js";
import { type Role, isRole } from "./roles.js";
import { ScopedCollection } from "./scoped.js";

export type KeyKind = "secret" | "public";

export interface ApiKeyRecord {
  /** Public identifier of the key (the lookup handle, not a secret). */
  id: string;
  tenantId: string;
  kind: KeyKind;
  /** Only secret keys carry a role. Public (widget) keys can only call the chat endpoint. */
  role: Role | null;
  label: string;
  /** SHA-256 of the secret part, hex. The secret itself is never stored. */
  secretHash: string;
  createdAt: number;
  revokedAt: number | null;
}

export type PublicKeyInfo = Omit<ApiKeyRecord, "secretHash">;

export interface IssuedKey {
  /** The full key string. Shown once, never recoverable. */
  key: string;
  record: PublicKeyInfo;
}

const PREFIX: Record<KeyKind, string> = { secret: "scs", public: "scp" };

function strip(record: ApiKeyRecord): PublicKeyInfo {
  const { secretHash: _omit, ...rest } = record;
  return rest;
}

/**
 * Per-tenant API keys.
 *
 * Key format: `<scs|scp>_<id>_<secret>`. Only a SHA-256 of the secret is stored. The secret is
 * 256 bits of CSPRNG output, so a fast hash is adequate (there is nothing to brute-force);
 * low-entropy credentials such as passwords would need a slow KDF instead.
 */
export class ApiKeyService {
  private readonly keys = new ScopedCollection<ApiKeyRecord>("API key");
  /** Authentication has to resolve the tenant from the key, so this one index is global by design. */
  private readonly tenantByKeyId = new Map<string, string>();
  private readonly dummyHash = sha256Hex("no-such-key");

  constructor(private readonly clock: Clock = systemClock) {}

  issue(tenantId: string, input: { kind: KeyKind; role?: Role; label?: string }): IssuedKey {
    if (input.kind === "secret" && !isRole(input.role)) throw new ValidationError("Secret keys need a role.");
    if (input.kind === "public" && input.role) throw new ValidationError("Public keys cannot have a role.");
    const label = (input.label ?? "").trim().slice(0, 80);
    const id = randomBytes(6).toString("hex");
    const secret = randomBytes(32).toString("base64url");
    const record: ApiKeyRecord = {
      id,
      tenantId,
      kind: input.kind,
      role: input.kind === "secret" ? (input.role as Role) : null,
      label,
      secretHash: sha256Hex(secret),
      createdAt: this.clock(),
      revokedAt: null,
    };
    this.keys.put(tenantId, record);
    this.tenantByKeyId.set(id, tenantId);
    return { key: `${PREFIX[input.kind]}_${id}_${secret}`, record: strip(record) };
  }

  /** Returns the key record when the presented key is valid and not revoked, else null. */
  authenticate(presented: string, expectedKind?: KeyKind): PublicKeyInfo | null {
    const parsed = /^(scs|scp)_([0-9a-f]{12})_([A-Za-z0-9_-]{20,64})$/.exec(presented);
    const tenantId = parsed ? this.tenantByKeyId.get(parsed[2]!) : undefined;
    const record = parsed && tenantId ? this.keys.get(tenantId, parsed[2]!) : undefined;
    // Always compare something so unknown ids and wrong secrets cost about the same.
    const expected = Buffer.from(record?.secretHash ?? this.dummyHash, "hex");
    const actual = Buffer.from(sha256Hex(parsed?.[3] ?? ""), "hex");
    const equal = timingSafeEqual(expected, actual);
    if (!record || !equal || record.revokedAt !== null) return null;
    if (PREFIX[record.kind] !== parsed![1]) return null;
    if (expectedKind && record.kind !== expectedKind) return null;
    return strip(record);
  }

  /** Looks up a public key by its full string; used where the key travels in a URL. */
  authenticatePublic(presented: string): PublicKeyInfo | null {
    return this.authenticate(presented, "public");
  }

  list(tenantId: string): PublicKeyInfo[] {
    return this.keys.list(tenantId).map(strip);
  }

  get(tenantId: string, id: string): PublicKeyInfo {
    return strip(this.keys.require(tenantId, id));
  }

  setRole(tenantId: string, id: string, role: Role): { before: PublicKeyInfo; after: PublicKeyInfo } {
    if (!isRole(role)) throw new ValidationError("Unknown role.");
    const before = this.keys.require(tenantId, id);
    if (before.kind !== "secret") throw new ValidationError("Only secret keys have roles.");
    if (before.revokedAt !== null) throw new ConflictError("Key is revoked.");
    if (before.role === "owner" && role !== "owner" && this.activeOwners(tenantId) <= 1) {
      throw new ConflictError("Cannot demote the last active owner key.");
    }
    const after = this.keys.update(tenantId, id, { role });
    return { before: strip(before), after: strip(after) };
  }

  revoke(tenantId: string, id: string): PublicKeyInfo {
    const current = this.keys.require(tenantId, id);
    if (current.revokedAt !== null) return strip(current);
    if (current.role === "owner" && this.activeOwners(tenantId) <= 1) {
      throw new ConflictError("Cannot revoke the last active owner key.");
    }
    return strip(this.keys.update(tenantId, id, { revokedAt: this.clock() }));
  }

  private activeOwners(tenantId: string): number {
    return this.keys.list(tenantId, (k) => k.role === "owner" && k.revokedAt === null).length;
  }

  /** Exposed for the isolation test that enumerates every tenant-scoped method. */
  get collection(): ScopedCollection<ApiKeyRecord> {
    return this.keys;
  }

  require(tenantId: string, id: string): PublicKeyInfo {
    const rec = this.keys.get(tenantId, id);
    if (!rec) throw new NotFoundError("API key");
    return strip(rec);
  }
}
