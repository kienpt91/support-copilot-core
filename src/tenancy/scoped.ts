import { NotFoundError, TenantMismatchError } from "../errors.js";

export interface TenantOwned {
  id: string;
  tenantId: string;
}

/**
 * In-memory collection that is physically partitioned by tenant id.
 *
 * Every method takes the tenant id as its first argument and only ever touches that
 * tenant's partition, so a record id from tenant A cannot resolve under tenant B even
 * if the ids collide. Records are cloned on the way in and out so callers cannot mutate
 * stored state by accident.
 */
export class ScopedCollection<T extends TenantOwned> {
  private readonly partitions = new Map<string, Map<string, T>>();

  constructor(readonly name: string) {}

  private partition(tenantId: string, create: boolean): Map<string, T> | undefined {
    if (typeof tenantId !== "string" || tenantId.length === 0) {
      throw new TypeError(`${this.name}: tenant id is required`);
    }
    let part = this.partitions.get(tenantId);
    if (!part && create) {
      part = new Map();
      this.partitions.set(tenantId, part);
    }
    return part;
  }

  put(tenantId: string, record: T): T {
    if (record.tenantId !== tenantId) throw new TenantMismatchError(tenantId, record.tenantId);
    const stored = structuredClone(record);
    this.partition(tenantId, true)!.set(record.id, stored);
    return structuredClone(stored);
  }

  get(tenantId: string, id: string): T | undefined {
    const found = this.partition(tenantId, false)?.get(id);
    return found ? structuredClone(found) : undefined;
  }

  require(tenantId: string, id: string): T {
    const found = this.get(tenantId, id);
    if (!found) throw new NotFoundError(this.name);
    return found;
  }

  has(tenantId: string, id: string): boolean {
    return this.partition(tenantId, false)?.has(id) ?? false;
  }

  list(tenantId: string, predicate?: (record: T) => boolean): T[] {
    const part = this.partition(tenantId, false);
    if (!part) return [];
    const out: T[] = [];
    for (const record of part.values()) {
      if (!predicate || predicate(record)) out.push(structuredClone(record));
    }
    return out;
  }

  findBy(tenantId: string, predicate: (record: T) => boolean): T | undefined {
    const part = this.partition(tenantId, false);
    if (!part) return undefined;
    for (const record of part.values()) {
      if (predicate(record)) return structuredClone(record);
    }
    return undefined;
  }

  update(tenantId: string, id: string, patch: Partial<Omit<T, "id" | "tenantId">>): T {
    const part = this.partition(tenantId, false);
    const current = part?.get(id);
    if (!part || !current) throw new NotFoundError(this.name);
    const next = { ...current, ...patch, id: current.id, tenantId: current.tenantId } as T;
    part.set(id, structuredClone(next));
    return structuredClone(next);
  }

  delete(tenantId: string, id: string): boolean {
    return this.partition(tenantId, false)?.delete(id) ?? false;
  }

  count(tenantId: string): number {
    return this.partition(tenantId, false)?.size ?? 0;
  }

  clearTenant(tenantId: string): number {
    const part = this.partition(tenantId, false);
    const n = part?.size ?? 0;
    part?.clear();
    return n;
  }
}
