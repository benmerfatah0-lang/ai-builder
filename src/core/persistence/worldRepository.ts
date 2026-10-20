import type { WorldPlan } from '../world-plan/schema';
import { worldPlanSchema } from '../world-plan/schema';
import { parseWorldPlan } from '../world-plan/migrate';

export interface WorldSummary {
  id: string;
  name: string;
  updatedAt: string;
  objectCount: number;
  schemaVersion: number;
}

export interface WorldRepository {
  readonly kind: 'indexeddb' | 'memory';
  list(): Promise<WorldSummary[]>;
  load(id: string): Promise<WorldPlan | null>;
  save(plan: WorldPlan): Promise<void>;
  delete(id: string): Promise<void>;
}

export const WORLDS_DB_NAME = 'ai-world-builder';
export const WORLDS_STORE_NAME = 'worlds';
const DB_VERSION = 1;

function summarize(plan: WorldPlan): WorldSummary {
  return {
    id: plan.id,
    name: plan.name,
    updatedAt: plan.updatedAt,
    objectCount: plan.objects.length,
    schemaVersion: plan.schemaVersion,
  };
}

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this environment.'));
      return;
    }

    const request = indexedDB.open(name, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(WORLDS_STORE_NAME)) {
        const store = database.createObjectStore(WORLDS_STORE_NAME, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('Could not open the local world database.'));
    request.onblocked = () =>
      reject(new Error('The local world database is blocked by another tab.'));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

/** Resolves only once the transaction has durably committed (or throws). */
function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('The local database transaction was aborted.'));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('The local database transaction failed.'));
  });
}

/** IndexedDB-backed project storage. Fully local: no network, no account. */
export function createIndexedDbWorldRepository(dbName = WORLDS_DB_NAME): WorldRepository {
  let databasePromise: Promise<IDBDatabase> | null = null;

  const database = () => {
    if (!databasePromise) databasePromise = openDatabase(dbName);
    return databasePromise;
  };

  return {
    kind: 'indexeddb',

    async list() {
      const db = await database();
      const transaction = db.transaction(WORLDS_STORE_NAME, 'readonly');
      const rows = await requestToPromise(
        transaction.objectStore(WORLDS_STORE_NAME).getAll() as IDBRequest<unknown[]>,
      );
      const summaries: WorldSummary[] = [];
      for (const row of rows) {
        try {
          summaries.push(summarize(parseWorldPlan(row)));
        } catch (error) {
          console.warn('Skipping an unreadable saved world.', error);
        }
      }
      return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async load(id) {
      const db = await database();
      const transaction = db.transaction(WORLDS_STORE_NAME, 'readonly');
      const row = await requestToPromise(
        transaction.objectStore(WORLDS_STORE_NAME).get(id) as IDBRequest<unknown>,
      );
      return row === undefined ? null : parseWorldPlan(row);
    },

    async save(plan) {
      // Validate before writing so a corrupt plan can never enter storage.
      const validated = worldPlanSchema.parse(plan);
      const db = await database();
      const transaction = db.transaction(WORLDS_STORE_NAME, 'readwrite');
      const done = transactionDone(transaction);
      await requestToPromise(transaction.objectStore(WORLDS_STORE_NAME).put(validated));
      await done;
    },

    async delete(id) {
      const db = await database();
      const transaction = db.transaction(WORLDS_STORE_NAME, 'readwrite');
      const done = transactionDone(transaction);
      await requestToPromise(transaction.objectStore(WORLDS_STORE_NAME).delete(id));
      await done;
    },
  };
}

/** Volatile repository used when IndexedDB is unavailable (e.g. hardened webviews). */
export function createMemoryWorldRepository(): WorldRepository {
  const worlds = new Map<string, WorldPlan>();
  return {
    kind: 'memory',
    async list() {
      return [...worlds.values()]
        .map(summarize)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async load(id) {
      return worlds.get(id) ?? null;
    },
    async save(plan) {
      worlds.set(plan.id, worldPlanSchema.parse(plan));
    },
    async delete(id) {
      worlds.delete(id);
    },
  };
}

let repository: WorldRepository | null = null;

export function getWorldRepository(): WorldRepository {
  if (!repository) {
    repository =
      typeof indexedDB === 'undefined'
        ? createMemoryWorldRepository()
        : createIndexedDbWorldRepository();
  }
  return repository;
}

/** Test/DI hook. */
export function setWorldRepository(next: WorldRepository | null): void {
  repository = next;
}
