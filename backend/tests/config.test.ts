import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveDatabaseUrl } from '../src/core/config.ts';

const parts = {
  POSTGRES_USER: 'taskly',
  POSTGRES_PASSWORD: 'secret',
  POSTGRES_HOST: 'db.internal',
  DB_PORT: '5433',
  POSTGRES_DB: 'taskly',
};

function stubParts(values: Partial<Record<keyof typeof parts, string>>) {
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

beforeEach(() => {
  // A developer's local .env must not leak into these cases.
  vi.stubEnv('DATABASE_URL', '');
  stubParts({ POSTGRES_USER: '', POSTGRES_PASSWORD: '', POSTGRES_HOST: '', DB_PORT: '', POSTGRES_DB: '' });
});

afterEach(() => vi.unstubAllEnvs());

describe('resolveDatabaseUrl', () => {
  it('prefers an explicit override over the environment', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://env:env@env-host:5432/env');
    expect(resolveDatabaseUrl('postgresql://override:pw@override-host:5432/app')).toBe('postgresql://override:pw@override-host:5432/app');
  });

  it('uses DATABASE_URL when no override is given', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://env:env@env-host:5432/env');
    expect(resolveDatabaseUrl()).toBe('postgresql://env:env@env-host:5432/env');
  });

  it.each([
    ['an override', (url: string) => resolveDatabaseUrl(url)],
    ['DATABASE_URL', (url: string) => (vi.stubEnv('DATABASE_URL', url), resolveDatabaseUrl())],
  ])('rewrites the SQLAlchemy psycopg scheme in %s to plain postgresql', (_source, resolve) => {
    expect(resolve('postgresql+psycopg://user:pw@host:5432/app')).toBe('postgresql://user:pw@host:5432/app');
  });

  it('builds the URL from the individual connection variables', () => {
    stubParts(parts);
    expect(resolveDatabaseUrl()).toBe('postgresql://taskly:secret@db.internal:5433/taskly');
  });

  it('encodes credentials and the database name so the URL stays valid', () => {
    stubParts({ ...parts, POSTGRES_USER: 'task ly', POSTGRES_PASSWORD: 'p@ss:w/rd', POSTGRES_DB: 'my db' });
    const url = new URL(resolveDatabaseUrl());
    expect(url.hostname).toBe('db.internal');
    expect(url.port).toBe('5433');
    expect(decodeURIComponent(url.username)).toBe('task ly');
    expect(decodeURIComponent(url.password)).toBe('p@ss:w/rd');
    expect(decodeURIComponent(url.pathname)).toBe('/my db');
  });

  it.each(Object.keys(parts))('reports a missing %s', (name) => {
    stubParts({ ...parts, [name]: '' });
    expect(() => resolveDatabaseUrl()).toThrow(`Missing environment variable: ${name}`);
  });
});
