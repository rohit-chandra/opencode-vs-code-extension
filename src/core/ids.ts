import { randomBytes, randomUUID } from 'node:crypto';

let counter = 0;

/** Sortable, collision-resistant id with a readable prefix (e.g. `msg_...`). */
export function newId(prefix: string): string {
  counter = (counter + 1) % 0xfff;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(2, '0')}${randomBytes(5).toString('hex')}`;
}

export const uuid = (): string => randomUUID();
